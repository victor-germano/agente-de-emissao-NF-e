export type PaymentSource = "stripe" | "gateway2_pix_parcelado";

export interface Patient {
  id: string;
  name: string;
  email: string;
  cpf: string;
}

export interface Doctor {
  id: string;
  name: string;
  crm: string;
}

/**
 * Evento de pagamento ja normalizado, independente do gateway de origem.
 * Todo adapter de gateway (Stripe, segundo gateway) deve produzir esse formato.
 */
export interface PaymentEvent {
  externalId: string;
  source: PaymentSource;
  patientId: string;
  amountCents: number;
  currency: string;
  occurredAt: string;
}

export type InvoiceStatus = "pending" | "processing" | "issued" | "failed" | "cancelled";

export interface Invoice {
  id: string;
  paymentExternalId: string;
  patientId: string;
  /** null quando o paciente nao tem medico associado (dado inconsistente) */
  doctorId: string | null;
  amountCents: number;
  status: InvoiceStatus;
  nfseNumber?: string;
  pdfUrl?: string;
  attempts: number;
  lastError?: string;
  /** Preenchido quando status === "cancelled" (ex: pagamento estornado). */
  cancellationReason?: string;
  /** Timestamp exato em que a nota foi emitida (status virou "issued"). Imutavel apos setado. */
  issuedAt?: string;
  /**
   * Tempo entre a chegada do pagamento (createdAt) e a nota sair (issuedAt), em ms -
   * inclui espera de retentativa, nao so a chamada final que deu certo. Ausente enquanto
   * a nota nao foi emitida (pending/processing/failed/cancelled sem nunca ter emitido).
   */
  emissionDurationMs?: number;
  createdAt: string;
  updatedAt: string;
}

/** Estorno/reembolso de um pagamento ja processado (ex: Stripe "charge.refunded"). */
export interface PaymentRefundEvent {
  paymentExternalId: string;
  occurredAt: string;
}
