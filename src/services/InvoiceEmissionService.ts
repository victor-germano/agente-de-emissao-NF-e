import { randomUUID } from "node:crypto";
import type { AlertNotifier } from "../adapters/alerting/AlertNotifier.js";
import type { AuditTrail } from "../adapters/audit/AuditTrail.js";
import type { Metrics } from "../adapters/metrics/Metrics.js";
import type { AppNotifier } from "../adapters/notifier/AppNotifier.js";
import type { EmailSender } from "../adapters/email/EmailSender.js";
import type { NFSeClient } from "../adapters/nfse/NFSeClient.js";
import { withRetry, type RetryOptions } from "../core/retry.js";
import type { Doctor, Invoice, Patient, PaymentEvent, PaymentRefundEvent } from "../domain/models.js";
import type { InvoiceRepository } from "../repositories/InvoiceRepository.js";
import type { PatientDoctorRepository } from "../repositories/PatientDoctorRepository.js";

export interface InvoiceEmissionServiceDeps {
  patientDoctorRepository: PatientDoctorRepository;
  invoiceRepository: InvoiceRepository;
  nfseClient: NFSeClient;
  emailSender: EmailSender;
  appNotifier: AppNotifier;
  alertNotifier: AlertNotifier;
  auditTrail: AuditTrail;
  metrics: Metrics;
  retryOptions: RetryOptions;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

type PreparedInvoice =
  | { done: true; invoice: Invoice }
  | { done: false; invoice: Invoice; patient: Patient; doctor: Doctor };

/**
 * Orquestra o fluxo TO-BE completo a partir de um evento de pagamento ja
 * normalizado (etapas 3 a 7 do documento):
 *   1. Associa paciente + medico responsavel automaticamente.
 *   2. Emite a NFS-e via NFSeClient, com retentativa/backoff.
 *   3. Persiste o resultado (sucesso ou falha, para acompanhamento).
 *   4. Envia e-mail ao paciente e notifica o App via webhook.
 *
 * Alem disso cobre lacunas que o AS-IS/TO-BE original nao antecipa: alertas
 * ativos, recuperacao de notas travadas (crash-safety), cancelamento por
 * estorno, trilha de auditoria imutavel e metricas basicas de saude.
 *
 * Falhas de e-mail/notificacao NAO revertem a nota ja emitida — sao
 * logadas e alertadas, mas nao bloqueiam o fluxo.
 */
export class InvoiceEmissionService {
  private readonly logger: Pick<Console, "info" | "warn" | "error">;

  constructor(private readonly deps: InvoiceEmissionServiceDeps) {
    this.logger = deps.logger ?? console;
  }

  /** Processa o pagamento do inicio ao fim, so retornando quando a nota estiver emitida/falhada. */
  async processPayment(event: PaymentEvent): Promise<Invoice> {
    const prepared = await this.prepareInvoice(event);
    if (prepared.done) return prepared.invoice;
    return this.emitInvoice(prepared.invoice, prepared.patient, prepared.doctor);
  }

  /**
   * Variante usada pelos webhooks HTTP: resolve a associacao
   * paciente/medico e garante a idempotencia de forma rapida (sem esperar a
   * emissao, que pode levar segundos com retentativas), devolvendo a
   * invoice ainda em "processing". A emissao continua em background — o
   * chamador deve consultar `GET /invoices/:id` (ou aguardar a notificacao
   * do App) para saber o resultado final. Sem isso, o endpoint do webhook
   * ficaria bloqueado tempo demais e arriscaria o gateway considerar a
   * entrega expirada e reenviar.
   */
  async acceptPaymentAsync(event: PaymentEvent): Promise<Invoice> {
    const prepared = await this.prepareInvoice(event);
    if (prepared.done) return prepared.invoice;

    void this.emitInvoice(prepared.invoice, prepared.patient, prepared.doctor).catch((error) => {
      this.logger.error(`[invoice-service] emissao em background falhou inesperadamente: ${String(error)}`);
    });

    return prepared.invoice;
  }

  /**
   * Varre invoices presas em "processing" (ex: o processo caiu no meio da
   * emissao) e tenta finaliza-las. Chamado periodicamente e no startup do
   * servico — sem isso, uma nota travada so seria notada se alguem checasse
   * manualmente, recriando a dependencia de operacao humana que o TO-BE
   * queria eliminar.
   */
  async recoverStuckInvoices(olderThanMs: number): Promise<{ checked: number; recovered: number }> {
    const stuck = (await this.deps.invoiceRepository.listByStatus("processing")).filter(
      (invoice) => Date.now() - new Date(invoice.updatedAt).getTime() >= olderThanMs,
    );

    for (const invoice of stuck) {
      await this.deps.alertNotifier.send({
        severity: "warning",
        title: "Nota travada em processamento",
        message: `Invoice ${invoice.id} (pagamento ${invoice.paymentExternalId}) estava presa em "processing" e sera reprocessada`,
        context: { invoiceId: invoice.id, paymentExternalId: invoice.paymentExternalId },
      });
      await this.deps.auditTrail.record({
        invoiceId: invoice.id,
        eventType: "recovery_attempt",
        fromStatus: "processing",
        toStatus: "processing",
        message: "Nota travada encontrada pela varredura de recuperacao, reprocessando",
      });

      const patient = await this.deps.patientDoctorRepository.findPatientById(invoice.patientId);
      const doctor = patient ? await this.deps.patientDoctorRepository.findLastDoctorForPatient(invoice.patientId) : null;

      if (!patient || !doctor) {
        await this.failForInconsistentData(invoice, !patient ? "paciente nao encontrado" : "nenhum medico associado ao paciente");
        continue;
      }

      await this.emitInvoice(invoice, patient, doctor);
      this.deps.metrics.increment("invoices.recovered");
    }

    return { checked: stuck.length, recovered: stuck.length };
  }

  /**
   * Cancela a NFS-e correspondente a um pagamento estornado. Nao esta no
   * documento original, mas e uma lacuna obvia: sem isso, um reembolso no
   * gateway deixa uma nota fiscal orfa no sistema.
   */
  async processRefund(event: PaymentRefundEvent): Promise<Invoice | null> {
    const invoice = await this.deps.invoiceRepository.findByPaymentExternalId(event.paymentExternalId);

    if (!invoice) {
      await this.deps.alertNotifier.send({
        severity: "warning",
        title: "Estorno recebido para pagamento desconhecido",
        message: `Nenhuma invoice encontrada para o pagamento ${event.paymentExternalId}`,
        context: { paymentExternalId: event.paymentExternalId },
      });
      return null;
    }

    if (invoice.status === "cancelled") {
      return invoice;
    }

    if (invoice.status !== "issued") {
      this.logger.info(`[invoice-service] Estorno para invoice ${invoice.id} com status "${invoice.status}" — marcando cancelada sem chamar a prefeitura`);
      const cancelled = await this.deps.invoiceRepository.update(invoice.id, {
        status: "cancelled",
        cancellationReason: "Pagamento estornado antes da emissao da nota",
      });
      await this.deps.auditTrail.record({
        invoiceId: invoice.id,
        eventType: "cancelled",
        fromStatus: invoice.status,
        toStatus: "cancelled",
        message: "Pagamento estornado antes da nota ser emitida",
      });
      this.deps.metrics.increment("invoices.cancelled");
      return cancelled;
    }

    try {
      if (invoice.nfseNumber) {
        await withRetry(() => this.deps.nfseClient.cancel(invoice.nfseNumber!), this.deps.retryOptions);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.alertNotifier.send({
        severity: "critical",
        title: "Falha ao cancelar NFS-e apos estorno",
        message: `Invoice ${invoice.id} (NFS-e ${invoice.nfseNumber}): ${message}`,
        context: { invoiceId: invoice.id, nfseNumber: invoice.nfseNumber },
      });
      throw error;
    }

    const cancelled = await this.deps.invoiceRepository.update(invoice.id, {
      status: "cancelled",
      cancellationReason: "Pagamento estornado",
    });
    await this.deps.auditTrail.record({
      invoiceId: invoice.id,
      eventType: "cancelled",
      fromStatus: "issued",
      toStatus: "cancelled",
      message: `NFS-e ${invoice.nfseNumber} cancelada apos estorno do pagamento`,
    });
    this.deps.metrics.increment("invoices.cancelled");

    const patient = await this.deps.patientDoctorRepository.findPatientById(invoice.patientId);
    if (patient && invoice.nfseNumber) {
      try {
        await this.deps.emailSender.sendCancellationEmail({
          patient,
          nfseNumber: invoice.nfseNumber,
          reason: "Pagamento estornado",
        });
      } catch (error) {
        this.logger.warn(`[invoice-service] Falha ao enviar e-mail de cancelamento da invoice ${invoice.id}: ${String(error)}`);
      }
    }

    return cancelled;
  }

  /**
   * Resolve idempotencia (via `findOrCreate` atomico, evitando duas
   * invoices para o mesmo pagamento sob concorrencia) e associacao
   * paciente+medico. Compartilhado por `processPayment` e
   * `acceptPaymentAsync` para nao duplicar essa logica.
   */
  private async prepareInvoice(event: PaymentEvent): Promise<PreparedInvoice> {
    const patient = await this.deps.patientDoctorRepository.findPatientById(event.patientId);
    const doctor = patient ? await this.deps.patientDoctorRepository.findLastDoctorForPatient(event.patientId) : null;

    const now = new Date().toISOString();
    const { invoice, created } = await this.deps.invoiceRepository.findOrCreate(event.externalId, () => ({
      id: randomUUID(),
      paymentExternalId: event.externalId,
      patientId: event.patientId,
      doctorId: doctor?.id ?? null,
      amountCents: event.amountCents,
      status: "processing",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }));

    if (!created) {
      this.logger.info(`[invoice-service] Evento ${event.externalId} ja processado (idempotencia), retornando invoice existente`);
      return { done: true, invoice };
    }

    await this.deps.auditTrail.record({
      invoiceId: invoice.id,
      eventType: "created",
      fromStatus: null,
      toStatus: "processing",
      message: `Invoice criada a partir do pagamento ${event.externalId}`,
    });

    if (!patient || !doctor) {
      const failed = await this.failForInconsistentData(invoice, !patient ? "paciente nao encontrado" : "nenhum medico associado ao paciente");
      return { done: true, invoice: failed };
    }

    return { done: false, invoice, patient, doctor };
  }

  private async failForInconsistentData(invoice: Invoice, reason: string): Promise<Invoice> {
    this.logger.error(`[invoice-service] Falha de dados para pagamento ${invoice.paymentExternalId}: ${reason}`);
    await this.deps.alertNotifier.send({
      severity: "critical",
      title: "Dados inconsistentes ao processar pagamento",
      message: `Invoice ${invoice.id} (pagamento ${invoice.paymentExternalId}): ${reason}`,
      context: { invoiceId: invoice.id, paymentExternalId: invoice.paymentExternalId },
    });
    const failed = await this.deps.invoiceRepository.update(invoice.id, {
      status: "failed",
      lastError: `Dados inconsistentes: ${reason}`,
    });
    await this.deps.auditTrail.record({
      invoiceId: invoice.id,
      eventType: "data_inconsistent",
      fromStatus: "processing",
      toStatus: "failed",
      message: reason,
    });
    this.deps.metrics.increment("invoices.failed");
    return failed;
  }

  private async emitInvoice(invoice: Invoice, patient: Patient, doctor: Doctor): Promise<Invoice> {
    const startedAt = Date.now();
    try {
      const { result, attempts } = await withRetry(
        () =>
          this.deps.nfseClient.emit({
            patientName: patient.name,
            patientCpf: patient.cpf,
            doctorName: doctor.name,
            amountCents: invoice.amountCents,
            description: `Atendimento medico - ${doctor.name}`,
          }),
        this.deps.retryOptions,
      );

      const issued = await this.deps.invoiceRepository.update(invoice.id, {
        status: "issued",
        nfseNumber: result.nfseNumber,
        pdfUrl: result.pdfUrl,
        attempts,
      });
      this.deps.metrics.increment("invoices.issued");
      this.deps.metrics.observeDurationMs("nfse.emit.duration_ms", Date.now() - startedAt);
      await this.deps.auditTrail.record({
        invoiceId: invoice.id,
        eventType: "issued",
        fromStatus: "processing",
        toStatus: "issued",
        message: `NFS-e ${result.nfseNumber} emitida apos ${attempts} tentativa(s)`,
        context: { attempts },
      });

      await this.notifyDownstream(issued, patient);
      return issued;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[invoice-service] Emissao falhou apos retentativas para pagamento ${invoice.paymentExternalId}: ${message}`);
      this.deps.metrics.increment("invoices.failed");
      await this.deps.alertNotifier.send({
        severity: "critical",
        title: "Falha ao emitir NFS-e",
        message: `Invoice ${invoice.id} (pagamento ${invoice.paymentExternalId}): ${message}`,
        context: { invoiceId: invoice.id, paymentExternalId: invoice.paymentExternalId },
      });
      const failed = await this.deps.invoiceRepository.update(invoice.id, {
        status: "failed",
        attempts: this.deps.retryOptions.maxAttempts,
        lastError: message,
      });
      await this.deps.auditTrail.record({
        invoiceId: invoice.id,
        eventType: "emission_failed",
        fromStatus: "processing",
        toStatus: "failed",
        message,
      });
      return failed;
    }
  }

  private async notifyDownstream(invoice: Invoice, patient: Patient): Promise<void> {
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
