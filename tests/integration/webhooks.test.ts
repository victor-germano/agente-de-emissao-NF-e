import { createHmac } from "node:crypto";
import type { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { InMemoryAlertNotifier } from "../../src/adapters/alerting/AlertNotifier.js";
import { InMemoryAuditTrail } from "../../src/adapters/audit/AuditTrail.js";
import { InMemoryMetrics } from "../../src/adapters/metrics/Metrics.js";
import { createApp } from "../../src/api/createApp.js";
import { ConsoleEmailSender } from "../../src/adapters/email/EmailSender.js";
import { HttpAppNotifier } from "../../src/adapters/notifier/AppNotifier.js";
import { PrefeituraMariliaMockClient } from "../../src/adapters/nfse/PrefeituraMariliaMockClient.js";
import { MockReconciliationGateway } from "../../src/adapters/reconciliation/ReconciliationGateway.js";
import { InMemoryInvoiceRepository } from "../../src/repositories/InvoiceRepository.js";
import { InMemoryPatientDoctorRepository } from "../../src/repositories/PatientDoctorRepository.js";
import type { HealthCheckResult } from "../../src/api/createApp.js";
import { InvoiceEmissionService } from "../../src/services/InvoiceEmissionService.js";
import { ReconciliationService } from "../../src/services/ReconciliationService.js";

function buildTestApp(
  opts: {
    stripeWebhookSecret?: string;
    gateway2WebhookSecret?: string;
    adminApiKey?: string;
    enableDebugRoutes?: boolean;
    healthCheck?: () => Promise<HealthCheckResult>;
  } = {},
) {
  const invoiceRepository = new InMemoryInvoiceRepository();
  const alertNotifier = new InMemoryAlertNotifier();
  const auditTrail = new InMemoryAuditTrail();
  const metrics = new InMemoryMetrics();
  const invoiceEmissionService = new InvoiceEmissionService({
    invoiceRepository,
    patientDoctorRepository: new InMemoryPatientDoctorRepository(),
    nfseClient: new PrefeituraMariliaMockClient({ failureRate: 0, latencyMs: 0 }),
    emailSender: new ConsoleEmailSender(),
    appNotifier: new HttpAppNotifier(undefined),
    alertNotifier,
    auditTrail,
    metrics,
    retryOptions: { maxAttempts: 3, baseDelayMs: 1 },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const reconciliationGateway = new MockReconciliationGateway();
  const reconciliationService = new ReconciliationService({
    gateway: reconciliationGateway,
    invoiceRepository,
    invoiceEmissionService,
    alertNotifier,
  });

  const app: Express = createApp({
    invoiceEmissionService,
    invoiceRepository,
    alertFeed: alertNotifier,
    webhookSecurity: { stripeWebhookSecret: opts.stripeWebhookSecret, gateway2WebhookSecret: opts.gateway2WebhookSecret },
    reconciliation: { service: reconciliationService, gateway: reconciliationGateway },
    auditTrail,
    metrics,
    adminApiKey: opts.adminApiKey,
    enableDebugRoutes: opts.enableDebugRoutes,
    healthCheck: opts.healthCheck,
  });

  return { app, alertNotifier, invoiceRepository, auditTrail, metrics };
}

function stripeSignatureHeader(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function waitForInvoiceStatus(app: Express, invoiceId: string, status: string, timeoutMs = 1000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request(app).get(`/invoices/${invoiceId}`);
    if (response.body.status === status) return response.body;
    if (Date.now() > deadline) throw new Error(`Timeout esperando invoice ${invoiceId} chegar em "${status}" (atual: ${response.body.status})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("POST /webhooks/stripe", () => {
  it("responde rapido com status processing e a nota fica issued pouco depois (ack desacoplado)", async () => {
    const { app } = buildTestApp();

    const webhookResponse = await request(app)
      .post("/webhooks/stripe")
      .send({
        id: "evt_1",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_123",
            amount: 20000,
            currency: "brl",
            metadata: { patient_id: "pat_2" },
          },
        },
      });

    expect(webhookResponse.status).toBe(202);
    expect(webhookResponse.body.status).toBe("processing");

    const finalInvoice = await waitForInvoiceStatus(app, webhookResponse.body.id, "issued");
    expect(finalInvoice.nfseNumber).toBeDefined();
  });

  it("rejeita payload invalido com 400", async () => {
    const { app } = buildTestApp();
    const response = await request(app).post("/webhooks/stripe").send({ foo: "bar" });
    expect(response.status).toBe(400);
  });

  it("processa um estorno (charge.refunded) e cancela a nota emitida", async () => {
    const { app } = buildTestApp();

    const paid = await request(app)
      .post("/webhooks/stripe")
      .send({
        id: "evt_2",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_456", amount: 10000, currency: "brl", metadata: { patient_id: "pat_1" } } },
      });
    await waitForInvoiceStatus(app, paid.body.id, "issued");

    const refunded = await request(app)
      .post("/webhooks/stripe")
      .send({ id: "evt_3", type: "charge.refunded", data: { object: { payment_intent: "pi_456" } } });

    expect(refunded.status).toBe(202);
    expect(refunded.body.status).toBe("cancelled");
  });

  describe("com STRIPE_WEBHOOK_SECRET configurado", () => {
    const secret = "whsec_test";

    it("aceita requisicao com assinatura valida", async () => {
      const { app } = buildTestApp({ stripeWebhookSecret: secret });
      const payload = {
        id: "evt_sig_ok",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_sig_ok", amount: 15000, currency: "brl", metadata: { patient_id: "pat_1" } } },
      };
      const body = JSON.stringify(payload);

      const response = await request(app)
        .post("/webhooks/stripe")
        .set("content-type", "application/json")
        .set("stripe-signature", stripeSignatureHeader(body, secret))
        .send(body);

      expect(response.status).toBe(202);
    });

    it("rejeita requisicao sem assinatura ou com assinatura invalida", async () => {
      const { app } = buildTestApp({ stripeWebhookSecret: secret });
      const payload = {
        id: "evt_sig_bad",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_sig_bad", amount: 15000, currency: "brl", metadata: { patient_id: "pat_1" } } },
      };

      const noSignature = await request(app).post("/webhooks/stripe").send(payload);
      expect(noSignature.status).toBe(400);

      const badSignature = await request(app)
        .post("/webhooks/stripe")
        .set("stripe-signature", "t=123,v1=deadbeef")
        .send(payload);
      expect(badSignature.status).toBe(400);
    });
  });
});

describe("POST /webhooks/gateway2", () => {
  it("processa evento de Pix/parcelado do segundo gateway", async () => {
    const { app } = buildTestApp();

    const response = await request(app)
      .post("/webhooks/gateway2")
      .send({
        transactionId: "pix_1",
        method: "pix",
        patientId: "pat_1",
        amountCents: 12000,
        paidAt: new Date().toISOString(),
      });

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("processing");
    await waitForInvoiceStatus(app, response.body.id, "issued");
  });

  it("rejeita requisicao sem o segredo correto quando GATEWAY2_WEBHOOK_SECRET esta configurado", async () => {
    const { app } = buildTestApp({ gateway2WebhookSecret: "shared-secret" });

    const response = await request(app)
      .post("/webhooks/gateway2")
      .send({ transactionId: "pix_2", method: "pix", patientId: "pat_1", amountCents: 5000, paidAt: new Date().toISOString() });

    expect(response.status).toBe(400);
  });
});

describe("recuperacao de notas travadas", () => {
  it("simula uma nota travada e a recupera via /debug/recover-stuck", async () => {
    const { app } = buildTestApp();

    const stuck = await request(app).post("/debug/simulate-stuck-invoice").send({ patientId: "pat_1", stuckForMs: 10 * 60_000 });
    expect(stuck.status).toBe(201);
    expect(stuck.body.status).toBe("processing");

    const recovered = await request(app).post("/debug/recover-stuck").send({ olderThanMs: 0 });
    expect(recovered.status).toBe(200);
    expect(recovered.body.recovered).toBe(1);

    const final = await request(app).get(`/invoices/${stuck.body.id}`);
    expect(final.body.status).toBe("issued");
  });
});

describe("reconciliacao", () => {
  it("simula um pagamento perdido e a reconciliacao preenche a nota faltante", async () => {
    const { app } = buildTestApp();

    const missed = await request(app).post("/debug/simulate-missed-payment").send({ patientId: "pat_2", amountCents: 8000 });
    expect(missed.status).toBe(201);

    const run = await request(app).post("/reconciliation/run").send();
    expect(run.status).toBe(200);
    expect(run.body.backfilled).toHaveLength(1);

    const invoices = await request(app).get("/invoices");
    expect(invoices.body).toHaveLength(1);
    expect(invoices.body[0].status).toBe("issued");
  });
});

describe("GET /alerts", () => {
  it("lista alertas recentes gerados por uma falha de dados", async () => {
    const { app } = buildTestApp();

    await request(app)
      .post("/webhooks/stripe")
      .send({
        id: "evt_unknown_patient",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_unknown", amount: 5000, currency: "brl", metadata: { patient_id: "pat_999" } } },
      });

    const alerts = await request(app).get("/alerts");
    expect(alerts.status).toBe(200);
    expect(alerts.body.length).toBeGreaterThan(0);
    expect(alerts.body[0].severity).toBe("critical");
  });
});

describe("GET /invoices/:id/audit", () => {
  it("lista a trilha de auditoria da invoice apos a emissao", async () => {
    const { app } = buildTestApp();

    const response = await request(app)
      .post("/webhooks/stripe")
      .send({
        id: "evt_audit",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_audit", amount: 7000, currency: "brl", metadata: { patient_id: "pat_1" } } },
      });
    await waitForInvoiceStatus(app, response.body.id, "issued");

    const audit = await request(app).get(`/invoices/${response.body.id}/audit`);
    expect(audit.status).toBe(200);
    expect(audit.body.map((entry: { eventType: string }) => entry.eventType)).toEqual(["created", "issued"]);
  });
});

describe("GET /metrics", () => {
  it("reflete contadores apos uma emissao bem-sucedida", async () => {
    const { app } = buildTestApp();

    const response = await request(app)
      .post("/webhooks/stripe")
      .send({
        id: "evt_metrics",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_metrics", amount: 3000, currency: "brl", metadata: { patient_id: "pat_1" } } },
      });
    await waitForInvoiceStatus(app, response.body.id, "issued");

    const metrics = await request(app).get("/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.body.counters["invoices.issued"]).toBe(1);
  });
});

describe("ADMIN_API_KEY protegendo endpoints de consulta/debug", () => {
  it("rejeita sem o token e aceita com o token correto", async () => {
    const { app } = buildTestApp({ adminApiKey: "top-secret" });

    const withoutToken = await request(app).get("/invoices");
    expect(withoutToken.status).toBe(401);

    const wrongToken = await request(app).get("/invoices").set("authorization", "Bearer errado");
    expect(wrongToken.status).toBe(401);

    const withToken = await request(app).get("/invoices").set("authorization", "Bearer top-secret");
    expect(withToken.status).toBe(200);
  });

  it("tambem protege /alerts, /metrics, /invoices/:id/audit e as rotas de debug/reconciliacao", async () => {
    const { app } = buildTestApp({ adminApiKey: "top-secret" });

    const endpoints = [
      { method: "get", path: "/alerts" },
      { method: "get", path: "/metrics" },
      { method: "get", path: "/invoices/algum-id/audit" },
      { method: "post", path: "/debug/recover-stuck" },
      { method: "post", path: "/debug/simulate-stuck-invoice" },
      { method: "post", path: "/debug/simulate-missed-payment" },
      { method: "post", path: "/reconciliation/run" },
    ] as const;

    for (const { method, path } of endpoints) {
      const response = await request(app)[method](path).send({});
      expect(response.status, `${method.toUpperCase()} ${path} deveria exigir autenticacao`).toBe(401);
    }
  });

  it("nao afeta os webhooks de pagamento nem o health check", async () => {
    const { app } = buildTestApp({ adminApiKey: "top-secret" });

    const health = await request(app).get("/health");
    expect(health.status).toBe(200);

    const payment = await request(app)
      .post("/webhooks/stripe")
      .send({
        id: "evt_auth_ok",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_auth_ok", amount: 1000, currency: "brl", metadata: { patient_id: "pat_1" } } },
      });
    expect(payment.status).toBe(202);
  });
});

describe("enableDebugRoutes", () => {
  it("retorna 404 para rotas de debug quando desabilitadas", async () => {
    const { app } = buildTestApp({ enableDebugRoutes: false });

    const responses = await Promise.all([
      request(app).post("/debug/recover-stuck").send({}),
      request(app).post("/debug/simulate-stuck-invoice").send({}),
      request(app).post("/debug/simulate-missed-payment").send({ patientId: "pat_1", amountCents: 100 }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
    }
  });

  it("nao afeta as rotas normais de negocio", async () => {
    const { app } = buildTestApp({ enableDebugRoutes: false });

    const response = await request(app)
      .post("/webhooks/stripe")
      .send({
        id: "evt_debug_disabled",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_debug_disabled", amount: 1000, currency: "brl", metadata: { patient_id: "pat_1" } } },
      });
    expect(response.status).toBe(202);

    const runReconciliation = await request(app).post("/reconciliation/run").send();
    expect(runReconciliation.status).toBe(200);
  });
});

describe("GET /health", () => {
  it("usa o status 'ok' padrao quando nenhum healthCheck customizado e fornecido", async () => {
    const { app } = buildTestApp();
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("reflete um healthCheck customizado saudavel", async () => {
    const { app } = buildTestApp({ healthCheck: async () => ({ ok: true, details: "supabase reachable" }) });
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", details: "supabase reachable" });
  });

  it("retorna 503 quando o healthCheck customizado reporta problema", async () => {
    const { app } = buildTestApp({ healthCheck: async () => ({ ok: false, details: "supabase: connection refused" }) });
    const response = await request(app).get("/health");
    expect(response.status).toBe(503);
    expect(response.body.status).toBe("degraded");
  });
});
