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

export type InvoiceStatus = "pending" | "processing" | "issued" | "failed";

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
  createdAt: string;
  updatedAt: string;
}
