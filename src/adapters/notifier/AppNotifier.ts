import { logger } from "../../lib/logger.js";

export interface InvoiceAvailableNotification {
  invoiceId: string;
  patientId: string;
  nfseNumber: string;
  pdfUrl: string;
}

/**
 * Cobre o passo 7 do TO-BE ("App notifica o paciente via webhook de que a
 * nota esta disponivel").
 */
export interface AppNotifier {
  notifyInvoiceAvailable(notification: InvoiceAvailableNotification): Promise<void>;
}

/**
 * Implementacao HTTP: faz POST para a URL configurada (o "App VYX" real).
 * Se nenhuma URL for configurada, apenas loga — util para rodar o
 * prototipo/testes sem um endpoint externo de verdade.
 */
export class HttpAppNotifier implements AppNotifier {
  constructor(private readonly webhookUrl: string | undefined) {}

  async notifyInvoiceAvailable(notification: InvoiceAvailableNotification): Promise<void> {
    if (!this.webhookUrl) {
      logger.info(
        "[app-notifier-mock] Nenhuma APP_NOTIFICATION_WEBHOOK_URL configurada, notificacao apenas logada",
        { ...notification },
      );
      return;
    }

    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "invoice.available", ...notification }),
    });

    if (!response.ok) {
      throw new Error(`Falha ao notificar app (${response.status})`);
    }
  }
}
