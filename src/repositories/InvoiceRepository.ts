import type { Invoice } from "../domain/models.js";

export interface FindOrCreateResult {
  invoice: Invoice;
  created: boolean;
}

export interface InvoiceRepository {
  create(invoice: Invoice): Promise<Invoice>;
  update(id: string, patch: Partial<Invoice>): Promise<Invoice>;
  findById(id: string): Promise<Invoice | null>;
  /** Usado para idempotencia: um mesmo evento de pagamento nao deve gerar duas notas. */
  findByPaymentExternalId(paymentExternalId: string): Promise<Invoice | null>;
  list(): Promise<Invoice[]>;
  listByStatus(status: Invoice["status"]): Promise<Invoice[]>;
  /**
   * Cria a invoice apenas se nenhuma outra existir com o mesmo
   * paymentExternalId, de forma atomica. Sem isso, duas entregas
   * concorrentes do mesmo webhook (comum em retries de gateway de
   * pagamento) poderiam passar pela checagem de idempotencia antes de
   * qualquer uma delas persistir, gerando duas notas para o mesmo
   * pagamento. `build` so e invocado se este chamador vencer a corrida.
   */
  findOrCreate(paymentExternalId: string, build: () => Invoice): Promise<FindOrCreateResult>;
}

/**
 * Implementacao in-memory para o prototipo/testes. Em producao seria
 * substituida por um SupabaseRepository (tabela `invoices`), ver README.
 */
export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly invoices = new Map<string, Invoice>();
  private readonly inFlightCreations = new Map<string, Promise<Invoice>>();

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

  async findOrCreate(paymentExternalId: string, build: () => Invoice): Promise<FindOrCreateResult> {
    const existing = await this.findByPaymentExternalId(paymentExternalId);
    if (existing) return { invoice: existing, created: false };

    // Depois do primeiro `await` acima, varias chamadas concorrentes para a
    // mesma chave podem retomar em qualquer ordem — mas cada retomada roda
    // o trecho abaixo (checar/gravar `inFlightCreations`) de forma
    // sincrona, sem nenhum `await` no meio. Por isso, a primeira chamada a
    // retomar grava sua promessa no mapa antes que qualquer outra tenha
    // chance de rodar, e as demais reaproveitam essa mesma promessa em vez
    // de criar a sua propria — eliminando a corrida.
    const inFlight = this.inFlightCreations.get(paymentExternalId);
    if (inFlight) {
      return { invoice: await inFlight, created: false };
    }

    // set() acontece dentro da criacao, sempre antes de qualquer delete() no
    // finally abaixo — entao nenhuma chamada concorrente pode ver "nao
    // existe em `invoices`" e "nao existe em `inFlightCreations`" ao mesmo
    // tempo, o que fecha a janela de corrida.
    const creation = Promise.resolve().then(() => {
      const invoice = build();
      this.invoices.set(invoice.id, invoice);
      return invoice;
    });
    this.inFlightCreations.set(paymentExternalId, creation);

    try {
      return { invoice: await creation, created: true };
    } finally {
      this.inFlightCreations.delete(paymentExternalId);
    }
  }
}
