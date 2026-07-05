import { describe, expect, it, vi } from "vitest";
import type { AlertNotifier } from "../../src/adapters/alerting/AlertNotifier.js";
import { MockReconciliationGateway } from "../../src/adapters/reconciliation/ReconciliationGateway.js";
import type { PaymentEvent } from "../../src/domain/models.js";
import { InMemoryInvoiceRepository } from "../../src/repositories/InvoiceRepository.js";
import { ReconciliationService } from "../../src/services/ReconciliationService.js";

function makePayment(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    externalId: "pay_missed",
    source: "stripe",
    patientId: "pat_1",
    amountCents: 9900,
    currency: "brl",
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ReconciliationService", () => {
  it("encontra pagamento sem nota, alerta e chama processPayment para preencher a lacuna", async () => {
    const gateway = new MockReconciliationGateway();
    gateway.addSimulatedPayment(makePayment());

    const invoiceRepository = new InMemoryInvoiceRepository();
    const alertNotifier: AlertNotifier = { send: vi.fn().mockResolvedValue(undefined) };
    const invoiceEmissionService = { processPayment: vi.fn().mockResolvedValue({ id: "inv_1" }) };

    const service = new ReconciliationService({
      gateway,
      invoiceRepository,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoiceEmissionService: invoiceEmissionService as any,
      alertNotifier,
    });

    const result = await service.run();

    expect(result).toEqual({ checked: 1, backfilled: ["pay_missed"] });
    expect(alertNotifier.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "warning" }));
    expect(invoiceEmissionService.processPayment).toHaveBeenCalledTimes(1);
  });

  it("nao alerta nem reprocessa pagamentos que ja tem invoice", async () => {
    const gateway = new MockReconciliationGateway();
    const payment = makePayment();
    gateway.addSimulatedPayment(payment);

    const invoiceRepository = new InMemoryInvoiceRepository();
    await invoiceRepository.create({
      id: "inv_existing",
      paymentExternalId: payment.externalId,
      patientId: payment.patientId,
      doctorId: "doc_1",
      amountCents: payment.amountCents,
      status: "issued",
      attempts: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const alertNotifier: AlertNotifier = { send: vi.fn().mockResolvedValue(undefined) };
    const invoiceEmissionService = { processPayment: vi.fn() };

    const service = new ReconciliationService({
      gateway,
      invoiceRepository,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoiceEmissionService: invoiceEmissionService as any,
      alertNotifier,
    });

    const result = await service.run();

    expect(result).toEqual({ checked: 1, backfilled: [] });
    expect(alertNotifier.send).not.toHaveBeenCalled();
    expect(invoiceEmissionService.processPayment).not.toHaveBeenCalled();
  });
});
