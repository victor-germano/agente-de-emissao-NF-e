import { randomUUID } from "node:crypto";
import type { InvoiceStatus } from "../../domain/models.js";

export interface AuditEntry {
  id: string;
  invoiceId: string;
  eventType: string;
  fromStatus: InvoiceStatus | null;
  toStatus: InvoiceStatus;
  message: string;
  context?: Record<string, unknown>;
  createdAt: string;
}

export type AuditEntryInput = Omit<AuditEntry, "id" | "createdAt">;

/**
 * Trilha de auditoria append-only de cada transicao de estado da nota
 * (criada, emitida, falhou, cancelada, recuperada). Nao esta no documento
 * original, mas e relevante por lidar com dados de saude/financeiros
 * (rastreabilidade para compliance) — diferente do `AlertNotifier`, que e
 * efemero e serve para chamar atencao agora, a trilha e permanente e serve
 * para reconstituir o historico depois.
 */
export interface AuditTrail {
  record(entry: AuditEntryInput): Promise<void>;
  listForInvoice(invoiceId: string): Promise<AuditEntry[]>;
}

export class InMemoryAuditTrail implements AuditTrail {
  private readonly entries: AuditEntry[] = [];

  async record(input: AuditEntryInput): Promise<void> {
    this.entries.push({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
  }

  async listForInvoice(invoiceId: string): Promise<AuditEntry[]> {
    return this.entries.filter((entry) => entry.invoiceId === invoiceId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
