import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditEntry, AuditEntryInput, AuditTrail } from "./AuditTrail.js";

interface AuditRow {
  id: string;
  invoice_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string;
  message: string;
  context: Record<string, unknown> | null;
  created_at: string;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    eventType: row.event_type,
    fromStatus: (row.from_status as AuditEntry["fromStatus"]) ?? null,
    toStatus: row.to_status as AuditEntry["toStatus"],
    message: row.message,
    context: row.context ?? undefined,
    createdAt: row.created_at,
  };
}

/** Persistencia real (tabela append-only `invoice_audit_log`). */
export class SupabaseAuditTrail implements AuditTrail {
  constructor(private readonly client: SupabaseClient) {}

  async record(input: AuditEntryInput): Promise<void> {
    const { error } = await this.client.from("invoice_audit_log").insert({
      invoice_id: input.invoiceId,
      event_type: input.eventType,
      from_status: input.fromStatus,
      to_status: input.toStatus,
      message: input.message,
      context: input.context ?? null,
    });
    if (error) throw new Error(`Falha ao gravar auditoria no Supabase: ${error.message}`);
  }

  async listForInvoice(invoiceId: string): Promise<AuditEntry[]> {
    const { data, error } = await this.client
      .from("invoice_audit_log")
      .select()
      .eq("invoice_id", invoiceId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`Falha ao listar auditoria da invoice ${invoiceId} no Supabase: ${error.message}`);
    return (data ?? []).map(toEntry);
  }
}
