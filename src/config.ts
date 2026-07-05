import "dotenv/config";

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: num(process.env.PORT, 3000),
  appNotificationWebhookUrl: process.env.APP_NOTIFICATION_WEBHOOK_URL || undefined,
  nfse: {
    mockFailureRate: num(process.env.NFSE_MOCK_FAILURE_RATE, 0),
    mockLatencyMs: num(process.env.NFSE_MOCK_LATENCY_MS, 150),
  },
  retry: {
    maxAttempts: num(process.env.NFSE_RETRY_MAX_ATTEMPTS, 3),
    baseDelayMs: num(process.env.NFSE_RETRY_BASE_DELAY_MS, 200),
  },
};
