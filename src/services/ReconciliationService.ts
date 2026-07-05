import type { AlertNotifier } from "../adapters/alerting/AlertNotifier.js";
import type { ReconciliationGateway } from "../adapters/reconciliation/ReconciliationGateway.js";
import type { InvoiceRepository } from "../repositories/InvoiceRepository.js";
import type { InvoiceEmissionService } from "./InvoiceEmissionService.js";

export interface ReconciliationServiceDeps {
  gateway: ReconciliationGateway;
  invoiceRepository: InvoiceRepository;
  invoiceEmissionService: InvoiceEmissionService;
  alertNotifier: AlertNotifier;
}

export interface ReconciliationResult {
  checked: number;
  backfilled: string[];
}

/**
 * Cobre uma lacuna que o documento nao antecipa: garantir que toda
 * transacao aprovada no gateway realmente virou uma nota fiscal, mesmo se o
 * webhook correspondente nunca chegou (rede instavel, downtime do agente,
 * etc). Roda periodicamente e tambem pode ser disparada manualmente
 * (POST /reconciliation/run).
 */
export class ReconciliationService {
  constructor(private readonly deps: ReconciliationServiceDeps) {}

  async run(): Promise<ReconciliationResult> {
    const payments = await this.deps.gateway.listRecentSuccessfulPayments();
    const backfilled: string[] = [];

    for (const payment of payments) {
      const existing = await this.deps.invoiceRepository.findByPaymentExternalId(payment.externalId);
      if (existing) continue;

      await this.deps.alertNotifier.send({
        severity: "warning",
        title: "Pagamento sem nota encontrado na reconciliacao",
        message: `Pagamento ${payment.externalId} estava aprovado no gateway mas nao tinha nota emitida — processando agora`,
        context: { paymentExternalId: payment.externalId },
      });

      await this.deps.invoiceEmissionService.processPayment(payment);
      backfilled.push(payment.externalId);
    }

    return { checked: payments.length, backfilled };
  }
}
