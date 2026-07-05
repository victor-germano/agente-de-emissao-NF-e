import type { PaymentEvent } from "../../domain/models.js";

/**
 * Em producao, isso consultaria a API do Stripe (ex: `charges.list`) para
 * obter os pagamentos bem-sucedidos recentes, permitindo comparar com o que
 * o agente efetivamente processou e pegar casos onde o webhook nunca
 * chegou. Nao esta no documento original, mas fecha uma lacuna real: sem
 * isso, uma falha silenciosa na entrega do webhook nunca e detectada.
 */
export interface ReconciliationGateway {
  listRecentSuccessfulPayments(): Promise<PaymentEvent[]>;
}

/**
 * Mock: mantem uma lista de pagamentos "simulados como perdidos" (ver
 * POST /debug/simulate-missed-payment), representando transacoes que o
 * gateway real reportaria como bem-sucedidas mas que nunca geraram um
 * webhook recebido pelo agente.
 */
export class MockReconciliationGateway implements ReconciliationGateway {
  private readonly payments: PaymentEvent[] = [];

  addSimulatedPayment(event: PaymentEvent): void {
    this.payments.push(event);
  }

  async listRecentSuccessfulPayments(): Promise<PaymentEvent[]> {
    return [...this.payments];
  }
}
