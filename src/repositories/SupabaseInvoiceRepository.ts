import type { SupabaseClient } from "@supabase/supabase-js";
import type { Invoice, InvoiceStatus } from "../domain/models.js";
import type { FindOrCreateResult, InvoiceRepository } from "./InvoiceRepository.js";

interface InvoiceRow {
  id: string;
  payment_external_id: string;
  patient_id: string;
  doctor_id: string | null;
  amount_cents: number;
  status: InvoiceStatus;
  nfse_number: string | null;
  pdf_url: string | null;
  attempts: number;
  last_error: string | null;
  cancellation_reason: string | null;
  issued_at: string | null;
  emission_duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

function toInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    paymentExternalId: row.payment_external_id,
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    amountCents: row.amount_cents,
    status: row.status,
    nfseNumber: row.nfse_number ?? undefined,
    pdfUrl: row.pdf_url ?? undefined,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    cancellationReason: row.cancellation_reason ?? undefined,
    issuedAt: row.issued_at ?? undefined,
    emissionDurationMs: row.emission_duration_ms ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(invoice: Invoice): InvoiceRow {
  return {
    id: invoice.id,
    payment_external_id: invoice.paymentExternalId,
    patient_id: invoice.patientId,
    doctor_id: invoice.doctorId,
    amount_cents: invoice.amountCents,
    status: invoice.status,
    nfse_number: invoice.nfseNumber ?? null,
    pdf_url: invoice.pdfUrl ?? null,
    attempts: invoice.attempts,
    last_error: invoice.lastError ?? null,
    cancellation_reason: invoice.cancellationReason ?? null,
    issued_at: invoice.issuedAt ?? null,
    emission_duration_ms: invoice.emissionDurationMs ?? null,
    created_at: invoice.createdAt,
    updated_at: invoice.updatedAt,
  };
}

const UNIQUE_VIOLATION = "23505";

/**
 * Persistencia real (tabela `invoices` no Supabase/Postgres). A unicidade de
 * `payment_external_id` e garantida por uma constraint UNIQUE no banco (ver
 * migration `create_invoices`), entao `findOrCreate` e atomico de verdade
 * via INSERT + tratamento do erro de conflito — sem precisar de um mutex em
 * memoria como no InMemoryInvoiceRepository.
 */
export class SupabaseInvoiceRepository implements InvoiceRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(invoice: Invoice): Promise<Invoice> {
    const { data, error } = await this.client.from("invoices").insert(toRow(invoice)).select().single();
    if (error) throw new Error(`Falha ao criar invoice no Supabase: ${error.message}`);
    return toInvoice(data);
  }

  async update(id: string, patch: Partial<Invoice>): Promise<Invoice> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.nfseNumber !== undefined) row.nfse_number = patch.nfseNumber;
    if (patch.pdfUrl !== undefined) row.pdf_url = patch.pdfUrl;
    if (patch.attempts !== undefined) row.attempts = patch.attempts;
    if (patch.lastError !== undefined) row.last_error = patch.lastError;
    if (patch.cancellationReason !== undefined) row.cancellation_reason = patch.cancellationReason;
    if (patch.doctorId !== undefined) row.doctor_id = patch.doctorId;
    if (patch.issuedAt !== undefined) row.issued_at = patch.issuedAt;
    if (patch.emissionDurationMs !== undefined) row.emission_duration_ms = patch.emissionDurationMs;

    const { data, error } = await this.client.from("invoices").update(row).eq("id", id).select().single();
    if (error) throw new Error(`Falha ao atualizar invoice ${id} no Supabase: ${error.message}`);
    return toInvoice(data);
  }

  async findById(id: string): Promise<Invoice | null> {
    const { data, error } = await this.client.from("invoices").select().eq("id", id).maybeSingle();
    if (error) throw new Error(`Falha ao buscar invoice ${id} no Supabase: ${error.message}`);
    return data ? toInvoice(data) : null;
  }

  async findByPaymentExternalId(paymentExternalId: string): Promise<Invoice | null> {
    const { data, error } = await this.client.from("invoices").select().eq("payment_external_id", paymentExternalId).maybeSingle();
    if (error) throw new Error(`Falha ao buscar invoice por pagamento ${paymentExternalId} no Supabase: ${error.message}`);
    return data ? toInvoice(data) : null;
  }

  async list(): Promise<Invoice[]> {
    const { data, error } = await this.client.from("invoices").select().order("created_at", { ascending: true });
    if (error) throw new Error(`Falha ao listar invoices no Supabase: ${error.message}`);
    return (data ?? []).map(toInvoice);
  }

  async listByStatus(status: Invoice["status"]): Promise<Invoice[]> {
    const { data, error } = await this.client.from("invoices").select().eq("status", status).order("created_at", { ascending: true });
    if (error) throw new Error(`Falha ao listar invoices com status ${status} no Supabase: ${error.message}`);
    return (data ?? []).map(toInvoice);
  }

  async findOrCreate(paymentExternalId: string, build: () => Invoice): Promise<FindOrCreateResult> {
    const invoice = build();
    const { data, error } = await this.client.from("invoices").insert(toRow(invoice)).select().single();

    if (!error) {
      return { invoice: toInvoice(data), created: true };
    }

    if (error.code === UNIQUE_VIOLATION) {
      const existing = await this.findByPaymentExternalId(paymentExternalId);
      if (existing) return { invoice: existing, created: false };
    }

    throw new Error(`Falha ao criar invoice (findOrCreate) no Supabase: ${error.message}`);
  }
}
