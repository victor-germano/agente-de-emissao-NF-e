import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Alert } from "../adapters/alerting/AlertNotifier.js";
import type { AuditTrail } from "../adapters/audit/AuditTrail.js";
import type { Metrics } from "../adapters/metrics/Metrics.js";
import { normalizeSecondGatewayEvent, normalizeStripeEvent, normalizeStripeRefundEvent } from "../adapters/paymentGateway/normalize.js";
import type { MockReconciliationGateway } from "../adapters/reconciliation/ReconciliationGateway.js";
import { SecondGatewayEventSchema, StripeEventSchema } from "../adapters/paymentGateway/schemas.js";
import { verifyStripeSignature } from "../adapters/paymentGateway/stripeSignature.js";
import type { InvoiceEmissionService } from "../services/InvoiceEmissionService.js";
import type { ReconciliationService } from "../services/ReconciliationService.js";
import type { InvoiceRepository } from "../repositories/InvoiceRepository.js";

export interface NFSeMockControl {
  getFailureRate(): number;
  setFailureRate(rate: number): void;
}

export interface AlertFeed {
  getRecent(limit?: number): Alert[];
}

export interface WebhookSecurity {
  stripeWebhookSecret?: string;
  gateway2WebhookSecret?: string;
}

export interface ReconciliationDeps {
  service: ReconciliationService;
  gateway: MockReconciliationGateway;
}

export interface CreateAppDeps {
  invoiceEmissionService: InvoiceEmissionService;
  invoiceRepository: InvoiceRepository;
  /** Se presente, habilita o painel/endpoints de debug do mock da prefeitura (uso local/demo). */
  nfseMockControl?: NFSeMockControl;
  /** Se presente, expoe GET /alerts para o painel visual. */
  alertFeed?: AlertFeed;
  /** Segredos para validar a origem dos webhooks; se ausentes, a checagem correspondente e pulada (uso local/demo). */
  webhookSecurity?: WebhookSecurity;
  /** Se presente, expoe endpoints de reconciliacao (manual + debug). */
  reconciliation?: ReconciliationDeps;
  /** Limite (ms) usado por defeito em POST /debug/recover-stuck quando nenhum "olderThanMs" e enviado. */
  recoveryDefaultThresholdMs?: number;
  /** Se presente, expoe GET /invoices/:id/audit. */
  auditTrail?: AuditTrail;
  /** Se presente, expoe GET /metrics. */
  metrics?: Metrics;
}

const FailureRateSchema = z.object({ rate: z.number().min(0).max(1) });
const SimulateMissedPaymentSchema = z.object({
  patientId: z.string(),
  amountCents: z.number().int().positive(),
});
const SimulateStuckInvoiceSchema = z.object({
  patientId: z.string().default("pat_1"),
  amountCents: z.number().int().positive().default(10000),
  stuckForMs: z.number().int().nonnegative().default(10 * 60_000),
});
const RecoverStuckSchema = z.object({ olderThanMs: z.number().int().nonnegative().optional() });

export function createApp(deps: CreateAppDeps): Express {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request).rawBody = buf;
      },
    }),
  );
  app.use(express.static(path.join(process.cwd(), "public")));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps.nfseMockControl) {
    const control = deps.nfseMockControl;

    app.get("/debug/nfse-failure-rate", (_req, res) => {
      res.json({ rate: control.getFailureRate() });
    });

    app.post("/debug/nfse-failure-rate", asyncHandler(async (req, res) => {
      const { rate } = FailureRateSchema.parse(req.body);
      control.setFailureRate(rate);
      res.json({ rate });
    }));
  }

  // Etapas 1-2 do TO-BE (pagamento) + estorno (charge.refunded, fora do documento original).
  app.post("/webhooks/stripe", asyncHandler(async (req, res) => {
    const secret = deps.webhookSecurity?.stripeWebhookSecret;
    if (secret) {
      const signatureHeader = req.header("stripe-signature");
      const valid = verifyStripeSignature(req.rawBody ?? Buffer.from(""), signatureHeader, secret);
      if (!valid) {
        res.status(400).json({ error: "invalid stripe-signature" });
        return;
      }
    }

    const event = StripeEventSchema.parse(req.body);
    if (event.type === "payment_intent.succeeded") {
      // Ack rapido: associa paciente/medico e garante idempotencia aqui, mas
      // a emissao (que pode levar segundos com retentativas) roda em
      // background para nao arriscar o Stripe considerar o webhook expirado.
      const invoice = await deps.invoiceEmissionService.acceptPaymentAsync(normalizeStripeEvent(event));
      res.status(202).json(invoice);
      return;
    }

    const invoice = await deps.invoiceEmissionService.processRefund(normalizeStripeRefundEvent(event));
    res.status(202).json(invoice ?? { received: true, note: "pagamento desconhecido" });
  }));

  // Etapa 1 do TO-BE ("futuramente tambem no segundo gateway, para Pix/parcelado").
  app.post("/webhooks/gateway2", asyncHandler(async (req, res) => {
    const secret = deps.webhookSecurity?.gateway2WebhookSecret;
    if (secret) {
      const provided = req.header("x-gateway2-secret");
      if (!provided || !safeEqual(provided, secret)) {
        res.status(400).json({ error: "invalid x-gateway2-secret" });
        return;
      }
    }

    const event = SecondGatewayEventSchema.parse(req.body);
    const invoice = await deps.invoiceEmissionService.acceptPaymentAsync(normalizeSecondGatewayEvent(event));
    res.status(202).json(invoice);
  }));

  // Endpoint de mock para receber a notificacao de webhook do proprio App (uso local/demo).
  app.post("/mock/app-webhook", (req, res) => {
    console.log("[mock-app-webhook] recebido:", req.body);
    res.status(200).json({ received: true });
  });

  app.get("/invoices", asyncHandler(async (_req, res) => {
    res.json(await deps.invoiceRepository.list());
  }));

  app.get("/invoices/failed", asyncHandler(async (_req, res) => {
    res.json(await deps.invoiceRepository.listByStatus("failed"));
  }));

  app.get("/invoices/:id", asyncHandler(async (req, res) => {
    const invoice = await deps.invoiceRepository.findById(req.params.id ?? "");
    if (!invoice) {
      res.status(404).json({ error: "invoice not found" });
      return;
    }
    res.json(invoice);
  }));

  if (deps.auditTrail) {
    const auditTrail = deps.auditTrail;
    app.get("/invoices/:id/audit", asyncHandler(async (req, res) => {
      res.json(await auditTrail.listForInvoice(req.params.id ?? ""));
    }));
  }

  if (deps.metrics) {
    const metrics = deps.metrics;
    app.get("/metrics", (_req, res) => {
      res.json(metrics.snapshot());
    });
  }

  app.post("/debug/recover-stuck", asyncHandler(async (req, res) => {
    const { olderThanMs } = RecoverStuckSchema.parse(req.body ?? {});
    const result = await deps.invoiceEmissionService.recoverStuckInvoices(olderThanMs ?? deps.recoveryDefaultThresholdMs ?? 0);
    res.json(result);
  }));

  app.post("/debug/simulate-stuck-invoice", asyncHandler(async (req, res) => {
    const { patientId, amountCents, stuckForMs } = SimulateStuckInvoiceSchema.parse(req.body ?? {});
    const stuckAt = new Date(Date.now() - stuckForMs).toISOString();
    const invoice = await deps.invoiceRepository.create({
      id: randomUUID(),
      paymentExternalId: `simulated_stuck_${randomUUID()}`,
      patientId,
      doctorId: null,
      amountCents,
      status: "processing",
      attempts: 0,
      createdAt: stuckAt,
      updatedAt: stuckAt,
    });
    res.status(201).json(invoice);
  }));

  if (deps.alertFeed) {
    const alertFeed = deps.alertFeed;
    app.get("/alerts", (_req, res) => {
      res.json(alertFeed.getRecent(50));
    });
  }

  if (deps.reconciliation) {
    const { service, gateway } = deps.reconciliation;

    app.post("/reconciliation/run", asyncHandler(async (_req, res) => {
      res.json(await service.run());
    }));

    app.post("/debug/simulate-missed-payment", asyncHandler(async (req, res) => {
      const { patientId, amountCents } = SimulateMissedPaymentSchema.parse(req.body);
      const event = {
        externalId: `simulated_missed_${randomUUID()}`,
        source: "stripe" as const,
        patientId,
        amountCents,
        currency: "brl",
        occurredAt: new Date().toISOString(),
      };
      gateway.addSimulatedPayment(event);
      res.status(201).json(event);
    }));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "invalid payload", details: err.issues });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
