import type { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/createApp.js";
import { ConsoleEmailSender } from "../../src/adapters/email/EmailSender.js";
import { HttpAppNotifier } from "../../src/adapters/notifier/AppNotifier.js";
import { PrefeituraMariliaMockClient } from "../../src/adapters/nfse/PrefeituraMariliaMockClient.js";
import { InMemoryInvoiceRepository } from "../../src/repositories/InvoiceRepository.js";
import { InMemoryPatientDoctorRepository } from "../../src/repositories/PatientDoctorRepository.js";
import { InvoiceEmissionService } from "../../src/services/InvoiceEmissionService.js";

function buildTestApp(): { app: Express } {
  const invoiceRepository = new InMemoryInvoiceRepository();
  const invoiceEmissionService = new InvoiceEmissionService({
    invoiceRepository,
    patientDoctorRepository: new InMemoryPatientDoctorRepository(),
    nfseClient: new PrefeituraMariliaMockClient({ failureRate: 0, latencyMs: 0 }),
    emailSender: new ConsoleEmailSender(),
    appNotifier: new HttpAppNotifier(undefined),
    retryOptions: { maxAttempts: 3, baseDelayMs: 1 },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  return { app: createApp({ invoiceEmissionService, invoiceRepository }) };
}

describe("POST /webhooks/stripe", () => {
  it("processa um evento valido e a nota fica disponivel via GET /invoices/:id", async () => {
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
    expect(webhookResponse.body.status).toBe("issued");

    const getResponse = await request(app).get(`/invoices/${webhookResponse.body.id}`);
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.nfseNumber).toBeDefined();
  });

  it("rejeita payload invalido com 400", async () => {
    const { app } = buildTestApp();
    const response = await request(app).post("/webhooks/stripe").send({ foo: "bar" });
    expect(response.status).toBe(400);
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
    expect(response.body.status).toBe("issued");
  });
});
