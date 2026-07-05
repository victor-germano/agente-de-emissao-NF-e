import { randomUUID } from "node:crypto";
import type { AppNotifier } from "../adapters/notifier/AppNotifier.js";
import type { EmailSender } from "../adapters/email/EmailSender.js";
import type { NFSeClient } from "../adapters/nfse/NFSeClient.js";
import { withRetry, type RetryOptions } from "../core/retry.js";
import type { Invoice, PaymentEvent } from "../domain/models.js";
import type { InvoiceRepository } from "../repositories/InvoiceRepository.js";
import type { PatientDoctorRepository } from "../repositories/PatientDoctorRepository.js";

export interface InvoiceEmissionServiceDeps {
  patientDoctorRepository: PatientDoctorRepository;
  invoiceRepository: InvoiceRepository;
  nfseClient: NFSeClient;
  emailSender: EmailSender;
  appNotifier: AppNotifier;
  retryOptions: RetryOptions;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

/**
 * Orquestra o fluxo TO-BE completo a partir de um evento de pagamento ja
 * normalizado (etapas 3 a 7 do documento):
 *   1. Associa paciente + medico responsavel automaticamente.
 *   2. Emite a NFS-e via NFSeClient, com retentativa/backoff.
 *   3. Persiste o resultado (sucesso ou falha, para acompanhamento).
 *   4. Envia e-mail ao paciente e notifica o App via webhook.
 *
 * Falhas de e-mail/notificacao NAO revertem a nota ja emitida — sao
 * logadas para alerta manual (ponto em aberto "alertas em caso de falha").
 */
export class InvoiceEmissionService {
  private readonly logger: Pick<Console, "info" | "warn" | "error">;

  constructor(private readonly deps: InvoiceEmissionServiceDeps) {
    this.logger = deps.logger ?? console;
  }

  async processPayment(event: PaymentEvent): Promise<Invoice> {
    const existing = await this.deps.invoiceRepository.findByPaymentExternalId(event.externalId);
    if (existing) {
      this.logger.info(`[invoice-service] Evento ${event.externalId} ja processado (idempotencia), retornando invoice existente`);
      return existing;
    }

    const patient = await this.deps.patientDoctorRepository.findPatientById(event.patientId);
    const doctor = patient ? await this.deps.patientDoctorRepository.findLastDoctorForPatient(event.patientId) : null;

    const now = new Date().toISOString();
    let invoice = await this.deps.invoiceRepository.create({
      id: randomUUID(),
      paymentExternalId: event.externalId,
      patientId: event.patientId,
      doctorId: doctor?.id ?? null,
      amountCents: event.amountCents,
      status: "processing",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });

    if (!patient || !doctor) {
      const reason = !patient ? "paciente nao encontrado" : "nenhum medico associado ao paciente";
      this.logger.error(`[invoice-service] Falha de dados para pagamento ${event.externalId}: ${reason}`);
      return this.deps.invoiceRepository.update(invoice.id, {
        status: "failed",
        lastError: `Dados inconsistentes: ${reason}`,
      });
    }

    try {
      const { result, attempts } = await withRetry(
        () =>
          this.deps.nfseClient.emit({
            patientName: patient.name,
            patientCpf: patient.cpf,
            doctorName: doctor.name,
            amountCents: event.amountCents,
            description: `Atendimento medico - ${doctor.name}`,
          }),
        this.deps.retryOptions,
      );

      invoice = await this.deps.invoiceRepository.update(invoice.id, {
        status: "issued",
        nfseNumber: result.nfseNumber,
        pdfUrl: result.pdfUrl,
        attempts,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[invoice-service] Emissao falhou apos retentativas para pagamento ${event.externalId}: ${message}`);
      return this.deps.invoiceRepository.update(invoice.id, {
        status: "failed",
        attempts: this.deps.retryOptions.maxAttempts,
        lastError: message,
      });
    }

    await this.notifyDownstream(invoice, patient);
    return invoice;
  }

  private async notifyDownstream(
    invoice: Invoice,
    patient: { id: string; name: string; email: string; cpf: string },
  ): Promise<void> {
    if (!invoice.nfseNumber || !invoice.pdfUrl) return;

    try {
      await this.deps.emailSender.sendInvoiceEmail({
        patient,
        nfseNumber: invoice.nfseNumber,
        pdfUrl: invoice.pdfUrl,
      });
    } catch (error) {
      this.logger.warn(`[invoice-service] Falha ao enviar e-mail da invoice ${invoice.id}: ${String(error)}`);
    }

    try {
      await this.deps.appNotifier.notifyInvoiceAvailable({
        invoiceId: invoice.id,
        patientId: patient.id,
        nfseNumber: invoice.nfseNumber,
        pdfUrl: invoice.pdfUrl,
      });
    } catch (error) {
      this.logger.warn(`[invoice-service] Falha ao notificar app para invoice ${invoice.id}: ${String(error)}`);
    }
  }
}
