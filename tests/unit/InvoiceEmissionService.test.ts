import { beforeEach, describe, expect, it, vi } from "vitest";
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

function makeService(nfseClient: NFSeClient, opts: { emailSender?: EmailSender; appNotifier?: AppNotifier } = {}) {
  const invoiceRepository = new InMemoryInvoiceRepository();
  const patientDoctorRepository = new InMemoryPatientDoctorRepository();
  const emailSender = opts.emailSender ?? { sendInvoiceEmail: vi.fn().mockResolvedValue(undefined) };
  const appNotifier = opts.appNotifier ?? { notifyInvoiceAvailable: vi.fn().mockResolvedValue(undefined) };

  const service = new InvoiceEmissionService({
    invoiceRepository,
    patientDoctorRepository,
    nfseClient,
    emailSender,
    appNotifier,
    retryOptions: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  return { service, invoiceRepository, emailSender, appNotifier };
}

describe("InvoiceEmissionService", () => {
  let successResult: NFSeEmissionResult;

  beforeEach(() => {
    successResult = { nfseNumber: "MARILIA-2026-TEST", pdfUrl: "https://example/nfse.pdf" };
  });

  it("associa medico automaticamente, emite a nota, envia e-mail e notifica o app", async () => {
    const nfseClient: NFSeClient = { emit: vi.fn().mockResolvedValue(successResult) };
    const { service, emailSender, appNotifier } = makeService(nfseClient);

    const invoice = await service.processPayment(makeEvent());

    expect(invoice.status).toBe("issued");
    expect(invoice.doctorId).toBe("doc_1");
    expect(invoice.nfseNumber).toBe("MARILIA-2026-TEST");
    expect(emailSender.sendInvoiceEmail).toHaveBeenCalledTimes(1);
    expect(appNotifier.notifyInvoiceAvailable).toHaveBeenCalledTimes(1);
  });

  it("e idempotente para o mesmo externalId de pagamento", async () => {
    const nfseClient: NFSeClient = { emit: vi.fn().mockResolvedValue(successResult) };
    const { service } = makeService(nfseClient);

    const first = await service.processPayment(makeEvent());
    const second = await service.processPayment(makeEvent());

    expect(second.id).toBe(first.id);
    expect(nfseClient.emit).toHaveBeenCalledTimes(1);
  });

  it("tenta novamente em caso de falha transitoria e emite com sucesso", async () => {
    const emit = vi
      .fn()
      .mockRejectedValueOnce(new NFSeEmissionError("prefeitura fora do ar"))
      .mockResolvedValue(successResult);
    const { service } = makeService({ emit });

    const invoice = await service.processPayment(makeEvent());

    expect(invoice.status).toBe("issued");
    expect(invoice.attempts).toBe(2);
  });

  it("marca a invoice como failed quando todas as tentativas se esgotam", async () => {
    const emit = vi.fn().mockRejectedValue(new NFSeEmissionError("prefeitura fora do ar"));
    const { service } = makeService({ emit });

    const invoice = await service.processPayment(makeEvent());

    expect(invoice.status).toBe("failed");
    expect(invoice.lastError).toContain("prefeitura fora do ar");
  });

  it("marca a invoice como failed quando o paciente nao e encontrado (dado inconsistente)", async () => {
    const nfseClient: NFSeClient = { emit: vi.fn() };
    const { service } = makeService(nfseClient);

    const invoice = await service.processPayment(makeEvent({ patientId: "pat_desconhecido", externalId: "pay_2" }));

    expect(invoice.status).toBe("failed");
    expect(invoice.doctorId).toBeNull();
    expect(nfseClient.emit).not.toHaveBeenCalled();
  });
});
