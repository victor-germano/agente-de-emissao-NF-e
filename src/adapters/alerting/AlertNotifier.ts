import { randomUUID } from "node:crypto";

export type AlertSeverity = "warning" | "critical";

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  context?: Record<string, unknown>;
  createdAt: string;
}

export type AlertInput = Omit<Alert, "id" | "createdAt">;

/**
 * Cobre o ponto em aberto "formato de retentativa e alertas em caso de
 * falha" do documento. Sem isso, uma nota que falha so fica visivel para
 * quem for checar `GET /invoices/failed` manualmente — o que recria o
 * problema original de dependencia de operacao humana.
 */
export interface AlertNotifier {
  send(input: AlertInput): Promise<void>;
}

/**
 * Guarda os ultimos alertas em memoria (consultavel via GET /alerts, usado
 * pelo painel visual) e loga no console. Em producao, trocar por um
 * AlertNotifier que posta num webhook do Slack/PagerDuty/e-mail da operacao
 * — a assinatura da interface e a mesma.
 */
export class InMemoryAlertNotifier implements AlertNotifier {
  private readonly alerts: Alert[] = [];

  constructor(private readonly maxSize = 100) {}

  async send(input: AlertInput): Promise<void> {
    const alert: Alert = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.alerts.unshift(alert);
    if (this.alerts.length > this.maxSize) {
      this.alerts.length = this.maxSize;
    }
    const log = alert.severity === "critical" ? console.error : console.warn;
    log(`[ALERT:${alert.severity}] ${alert.title} — ${alert.message}`, alert.context ?? "");
  }

  getRecent(limit = 20): Alert[] {
    return this.alerts.slice(0, limit);
  }
}
