import type { Invoice } from "../domain/models.js";

export interface InvoiceRepository {
  create(invoice: Invoice): Promise<Invoice>;
  update(id: string, patch: Partial<Invoice>): Promise<Invoice>;
  findById(id: string): Promise<Invoice | null>;
  /** Usado para idempotencia: um mesmo evento de pagamento nao deve gerar duas notas. */
  findByPaymentExternalId(paymentExternalId: string): Promise<Invoice | null>;
  list(): Promise<Invoice[]>;
  listByStatus(status: Invoice["status"]): Promise<Invoice[]>;
}

/**
 * Implementacao in-memory para o prototipo/testes. Em producao seria
 * substituida por um SupabaseRepository (tabela `invoices`), ver README.
 */
export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly invoices = new Map<string, Invoice>();

  async create(invoice: Invoice): Promise<Invoice> {
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  async update(id: string, patch: Partial<Invoice>): Promise<Invoice> {
    const current = this.invoices.get(id);
    if (!current) {
      throw new Error(`Invoice not found: ${id}`);
    }
    const updated: Invoice = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.invoices.set(id, updated);
    return updated;
  }

  async findById(id: string): Promise<Invoice | null> {
    return this.invoices.get(id) ?? null;
  }

  async findByPaymentExternalId(paymentExternalId: string): Promise<Invoice | null> {
    for (const invoice of this.invoices.values()) {
      if (invoice.paymentExternalId === paymentExternalId) {
        return invoice;
      }
    }
    return null;
  }

  async list(): Promise<Invoice[]> {
    return [...this.invoices.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listByStatus(status: Invoice["status"]): Promise<Invoice[]> {
    return (await this.list()).filter((invoice) => invoice.status === status);
  }
}
