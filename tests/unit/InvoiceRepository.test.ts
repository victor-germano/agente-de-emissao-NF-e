import { describe, expect, it, vi } from "vitest";
import type { Invoice } from "../../src/domain/models.js";
import { InMemoryInvoiceRepository } from "../../src/repositories/InvoiceRepository.js";

function buildInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    paymentExternalId: "pay_1",
    patientId: "pat_1",
    doctorId: "doc_1",
    amountCents: 1000,
    status: "processing",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("InMemoryInvoiceRepository.findOrCreate", () => {
  it("cria na primeira chamada e reaproveita na segunda para a mesma chave", async () => {
    const repo = new InMemoryInvoiceRepository();
    const build = vi.fn(() => buildInvoice());

    const first = await repo.findOrCreate("pay_1", build);
    const second = await repo.findOrCreate("pay_1", build);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.invoice.id).toBe(first.invoice.id);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("sob concorrencia, so uma chamada cria a invoice", async () => {
    const repo = new InMemoryInvoiceRepository();
    const build = vi.fn(() => buildInvoice());

    const results = await Promise.all([
      repo.findOrCreate("pay_race", build),
      repo.findOrCreate("pay_race", build),
      repo.findOrCreate("pay_race", build),
    ]);

    const createdCount = results.filter((r) => r.created).length;
    expect(createdCount).toBe(1);
    expect(build).toHaveBeenCalledTimes(1);
    const ids = new Set(results.map((r) => r.invoice.id));
    expect(ids.size).toBe(1);
  });
});
