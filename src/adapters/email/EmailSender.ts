import type { Patient } from "../../domain/models.js";

export interface InvoiceEmailPayload {
  patient: Patient;
  nfseNumber: string;
  pdfUrl: string;
}

/**
 * Cobre o passo 6 do TO-BE ("sistema envia copia por e-mail automaticamente
 * ao paciente"). Em producao seria implementado com um provedor real
 * (SES/SendGrid/SMTP); aqui fica logado para fins de demo/teste.
 */
export interface EmailSender {
  sendInvoiceEmail(payload: InvoiceEmailPayload): Promise<void>;
}

export class ConsoleEmailSender implements EmailSender {
  async sendInvoiceEmail(payload: InvoiceEmailPayload): Promise<void> {
    console.log(
      `[email-mock] Enviando NFS-e ${payload.nfseNumber} para ${payload.patient.name} <${payload.patient.email}> (${payload.pdfUrl})`,
    );
  }
}
