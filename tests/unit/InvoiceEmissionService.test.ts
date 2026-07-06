import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertNotifier } from "../../src/adapters/alerting/AlertNotifier.js";
import { InMemoryAuditTrail } from "../../src/adapters/audit/AuditTrail.js";
import { InMemoryMetrics } from "../../src/adapters/metrics/Metrics.js";
import type { AppNotifier } from "../../src/adapters/notifier/AppNotifier.js";
import type { EmailSender } from "../../src/adapters/email/EmailSender.js";
import type { NFSeClient, NFSeEmissionResult } from "../../src/adapters/nfse/NFSeClient.js";
import { NFSeEmissionError } from "../../src/adapters/nfse/NFSeClient.js";
import type { PaymentEvent } from "../../src/domain/models.js";
import { InMemoryInvoiceRepository } from "../../src/repositories/InvoiceRepository.js";
import { InMemoryPatientDoctorRepository } from "../../src/repositories/PatientDoctorRepository.js";
import { InvoiceEmissionService } from "../../src/services/InvoiceEmissionService.js";

function makeEvent(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    externalId: "pay_1",
    source: "stripe",
    patientId: "pat_1",
    amountCents: 15000,
    currency: "brl",
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeEmailSender(): EmailSender {
  return {
    sendInvoiceEmail: vi.fn().mockResolvedValue(undefined),
    sendCancellationEmail: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeAppNotifier(): AppNotifier {
  return { notifyInvoiceAvailable: vi.fn().mockResolvedValue(undefined) };
}

function fakeAlertNotifier(): AlertNotifier {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

function makeService(
  nfseClient: NFSeClient,
  opts: { emailSender?: EmailSender; appNotifier?: AppNotifier; alertNotifier?: AlertNotifier } = {},
) {
  const invoiceRepository = new InMemoryInvoiceRepository();
  const patientDoctorRepository = new InMemoryPatientDoctorRepository();
  const emailSender = opts.emailSender ?? fakeEmailSender();
  const appNotifier = opts.appNotifier ?? fakeAppNotifier();
  const alertNotifier = opts.alertNotifier ?? fakeAlertNotifier();
  const auditTrail = new InMemoryAuditTrail();
  const metrics = new InMemoryMetrics();

  const service = new InvoiceEmissionService({
    invoiceRepository,
    patientDoctorRepository,
    nfseClient,
    emailSender,
    appNotifier,
    alertNotifier,
    auditTrail,
    metrics,
    retryOptions: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  return { service, invoiceRepository, emailSender, appNotifier, alertNotifier, auditTrail, metrics };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("InvoiceEmissionService", () => {
  let successResult: NFSeEmissionResult;

  beforeEach(() => {
    successResult = { nfseNumber: "MARILIA-2026-TEST", pdfUrl: "https://example/nfse.pdf" };
  });

  it("associa medico automaticamente, emite a nota, envia e-mail e notifica o app", async () => {
    const nfseClient: NFSeClient = { emit: vi.fn().mockResolvedValue(successResult), cancel: vi.fn() };
    const { service, emailSender, appNotifier } = makeService(nfseClient);

    const invoice = await service.processPayment(makeEvent());

    expect(invoice.status).toBe("issued");
    expect(invoice.doctorId).toBe("doc_1");
    expect(invoice.nfseNumber).toBe("MARILIA-2026-TEST");
    expect(emailSender.sendInvoiceEmail).toHaveBeenCalledTimes(1);
    expect(appNotifier.notifyInvoiceAvailable).toHaveBeenCalledTimes(1);
  });

  it("e idempotente para o mesmo externalId de pagamento", async () => {
    const nfseClient: NFSeClient = { emit: vi.fn().mockResolvedValue(successResult), cancel: vi.fn() };
    const { service } = makeService(nfseClient);

    const first = await service.processPayment(makeEvent());
    const second = await service.processPayment(makeEvent());

    expect(second.id).toBe(first.id);
    expect(nfseClient.emit).toHaveBeenCalledTimes(1);
  });

  it("nao cria duas invoices quando o mesmo pagamento chega concorrentemente (race condition)", async () => {
    const nfseClient: NFSeClient = { emit: vi.fn().mockResolvedValue(successResult), cancel: vi.fn() };
    const { service, invoiceRepository } = makeService(nfseClient);

    const event = makeEvent();
    const [first, second] = await Promise.all([service.processPayment(event), service.processPayment(event)]);

    expect(first.id).toBe(second.id);
    expect(nfseClient.emit).toHaveBeenCalledTimes(1);
    expect((await invoiceRepository.list())).toHaveLength(1);
  });

  it("tenta novamente em caso de falha transitoria e emite com sucesso", async () => {
    const emit = vi
      .fn()
      .mockRejectedValueOnce(new NFSeEmissionError("prefeitura fora do ar"))
      .mockResolvedValue(successResult);
    const { service } = makeService({ emit, cancel: vi.fn() });

    const invoice = await service.processPayment(makeEvent());

    expect(invoice.status).toBe("issued");
    expect(invoice.attempts).toBe(2);
  });

  it("marca a invoice como failed e dispara alerta quando todas as tentativas se esgotam", async () => {
    const emit = vi.fn().mockRejectedValue(new NFSeEmissionError("prefeitura fora do ar"));
    const { service, alertNotifier, metrics } = makeService({ emit, cancel: vi.fn() });

    const invoice = await service.processPayment(makeEvent());

    expect(invoice.status).toBe("failed");
    expect(invoice.lastError).toContain("prefeitura fora do ar");
    expect(alertNotifier.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
    expect(metrics.snapshot().counters["invoices.failed"]).toBe(1);
  });

  it("marca a invoice como failed e dispara alerta quando o paciente nao e encontrado (dado inconsistente)", async () => {
    const nfseClient: NFSeClient = { emit: vi.fn(), cancel: vi.fn() };
    const { service, alertNotifier } = makeService(nfseClient);

    const invoice = await service.processPayment(makeEvent({ patientId: "pat_desconhecido", externalId: "pay_2" }));

    expect(invoice.status).toBe("failed");
    expect(invoice.doctorId).toBeNull();
    expect(nfseClient.emit).not.toHaveBeenCalled();
    expect(alertNotifier.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
  });

  it("registra a trilha de auditoria e as metricas de uma emissao bem-sucedida", async () => {
    const nfseClient: NFSeClient = { emit: vi.fn().mockResolvedValue(successResult), cancel: vi.fn() };
    const { service, auditTrail, metrics } = makeService(nfseClient);

    const invoice = await service.processPayment(makeEvent());

    const entries = await auditTrail.listForInvoice(invoice.id);
    expect(entries.map((e) => e.eventType)).toEqual(["created", "issued"]);
    expect(metrics.snapshot().counters["invoices.issued"]).toBe(1);
    expect(metrics.snapshot().durations["nfse.emit.duration_ms"]?.count).toBe(1);
  });

  describe("acceptPaymentAsync", () => {
    it("retorna rapido com status processing e finaliza a emissao em background", async () => {
      const emit = vi.fn().mockImplementation(() => delay(20).then(() => successResult));
      const { service, invoiceRepository } = makeService({ emit, cancel: vi.fn() });

      const accepted = await service.acceptPaymentAsync(makeEvent());
      expect(accepted.status).toBe("processing");

      await delay(60);

      const final = await invoiceRepository.findById(accepted.id);
      expect(final?.status).toBe("issued");
    });
  });

  describe("waitForIdle", () => {
    it("resolve sem pendencias quando a emissao em background termina antes do timeout", async () => {
      const emit = vi.fn().mockImplementation(() => delay(10).then(() => successResult));
      const { service } = makeService({ emit, cancel: vi.fn() });

      await service.acceptPaymentAsync(makeEvent());
      const { pendingAtTimeout } = await service.waitForIdle(200);

      expect(pendingAtTimeout).toBe(0);
    });

    it("reporta pendencia quando o timeout expira antes da emissao terminar", async () => {
      const emit = vi.fn().mockImplementation(() => delay(200).then(() => successResult));
      const { service } = makeService({ emit, cancel: vi.fn() });

      await service.acceptPaymentAsync(makeEvent());
      const { pendingAtTimeout } = await service.waitForIdle(20);

      expect(pendingAtTimeout).toBe(1);
    });

    it("resolve imediatamente quando nao ha nenhuma emissao em background", async () => {
      const nfseClient: NFSeClient = { emit: vi.fn(), cancel: vi.fn() };
      const { service } = makeService(nfseClient);

      const { pendingAtTimeout } = await service.waitForIdle(200);
      expect(pendingAtTimeout).toBe(0);
    });
  });

  describe("recoverStuckInvoices", () => {
    it("reprocessa invoices presas em processing e as emite", async () => {
      const nfseClient: NFSeClient = { emit: vi.fn().mockResolvedValue(successResult), cancel: vi.fn() };
      const { service, invoiceRepository, alertNotifier } = makeService(nfseClient);

      const stuckAt = new Date(Date.now() - 5 * 60_000).toISOString();
      await invoiceRepository.create({
        id: "inv_stuck",
        paymentExternalId: "pay_stuck",
        patientId: "pat_1",
        doctorId: null,
        amountCents: 5000,
        status: "processing",
        attempts: 0,
        createdAt: stuckAt,
        updatedAt: stuckAt,
      });

      const result = await service.recoverStuckInvoices(60_000);

      expect(result).toEqual({ checked: 1, recovered: 1 });
      const recovered = await invoiceRepository.findById("inv_stuck");
      expect(recovered?.status).toBe("issued");
      expect(alertNotifier.send).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("travada") }));
    });

    it("ignora invoices em processing que ainda estao dentro do limite de tempo", async () => {
      const nfseClient: NFSeClient = { emit: vi.fn().mockResolvedValue(successResult), cancel: vi.fn() };
      const { service, invoiceRepository } = makeService(nfseClient);

      const now = new Date().toISOString();
      await invoiceRepository.create({
        id: "inv_fresh",
        paymentExternalId: "pay_fresh",
        patientId: "pat_1",
        doctorId: null,
        amountCents: 5000,
        status: "processing",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });

      const result = await service.recoverStuckInvoices(60_000);

      expect(result).toEqual({ checked: 0, recovered: 0 });
      expect(nfseClient.emit).not.toHaveBeenCalled();
    });
  });

  describe("processRefund", () => {
    it("cancela a NFS-e emitida e envia e-mail de cancelamento", async () => {
      const nfseClient: NFSeClient = { emit: vi.fn().mockResolvedValue(successResult), cancel: vi.fn().mockResolvedValue(undefined) };
      const { service, emailSender } = makeService(nfseClient);

      await service.processPayment(makeEvent());
      const cancelled = await service.processRefund({ paymentExternalId: "pay_1", occurredAt: new Date().toISOString() });

      expect(cancelled?.status).toBe("cancelled");
      expect(nfseClient.cancel).toHaveBeenCalledWith("MARILIA-2026-TEST");
      expect(emailSender.sendCancellationEmail).toHaveBeenCalledTimes(1);
    });

    it("retorna null e alerta quando o pagamento estornado e desconhecido", async () => {
      const nfseClient: NFSeClient = { emit: vi.fn(), cancel: vi.fn() };
      const { service, alertNotifier } = makeService(nfseClient);

      const result = await service.processRefund({ paymentExternalId: "pay_desconhecido", occurredAt: new Date().toISOString() });

      expect(result).toBeNull();
      expect(alertNotifier.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "warning" }));
    });

    it("e idempotente para uma invoice ja cancelada", async () => {
      const nfseClient: NFSeClient = { emit: vi.fn().mockResolvedValue(successResult), cancel: vi.fn().mockResolvedValue(undefined) };
      const { service } = makeService(nfseClient);

      await service.processPayment(makeEvent());
      await service.processRefund({ paymentExternalId: "pay_1", occurredAt: new Date().toISOString() });
      const secondCall = await service.processRefund({ paymentExternalId: "pay_1", occurredAt: new Date().toISOString() });

      expect(secondCall?.status).toBe("cancelled");
      expect(nfseClient.cancel).toHaveBeenCalledTimes(1);
    });

    it("cancela sem chamar a prefeitura quando a nota nunca chegou a ser emitida", async () => {
      const emit = vi.fn().mockRejectedValue(new NFSeEmissionError("prefeitura fora do ar"));
      const cancel = vi.fn().mockResolvedValue(undefined);
      const { service } = makeService({ emit, cancel });

      await service.processPayment(makeEvent());
      const cancelled = await service.processRefund({ paymentExternalId: "pay_1", occurredAt: new Date().toISOString() });

      expect(cancelled?.status).toBe("cancelled");
      expect(cancel).not.toHaveBeenCalled();
    });
  });
});
