import "dotenv/config";

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  env: process.env.NODE_ENV || "development",
  port: num(process.env.PORT, 3000),
  appNotificationWebhookUrl: process.env.APP_NOTIFICATION_WEBHOOK_URL || undefined,
  nfse: {
    mockFailureRate: num(process.env.NFSE_MOCK_FAILURE_RATE, 0),
    mockLatencyMs: num(process.env.NFSE_MOCK_LATENCY_MS, 150),
    apiToken: process.env.NFSE_API_TOKEN || undefined,
  },
  retry: {
    maxAttempts: num(process.env.NFSE_RETRY_MAX_ATTEMPTS, 3),
    baseDelayMs: num(process.env.NFSE_RETRY_BASE_DELAY_MS, 200),
  },
  /** Limite (ms) de pagamento->nota emitida acima do qual dispara alerta de SLA. */
  emissionSlaMs: num(process.env.EMISSION_SLA_MS, 5000),
  security: {
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || undefined,
    gateway2WebhookSecret: process.env.GATEWAY2_WEBHOOK_SECRET || undefined,
    adminApiKey: process.env.ADMIN_API_KEY || undefined,
  },
  recovery: {
    stuckInvoiceThresholdMs: num(process.env.STUCK_INVOICE_THRESHOLD_MS, 60_000),
    sweepIntervalMs: num(process.env.RECOVERY_SWEEP_INTERVAL_MS, 60_000),
  },
  reconciliation: {
    intervalMs: num(process.env.RECONCILIATION_INTERVAL_MS, 120_000),
  },
  supabase: {
    url: process.env.SUPABASE_URL || undefined,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
  },
};
