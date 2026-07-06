import type { Server } from "node:http";
import { InMemoryAlertNotifier } from "./adapters/alerting/AlertNotifier.js";
import { InMemoryAuditTrail } from "./adapters/audit/AuditTrail.js";
import { SupabaseAuditTrail } from "./adapters/audit/SupabaseAuditTrail.js";
import { InMemoryMetrics } from "./adapters/metrics/Metrics.js";
import { createApp, type HealthCheckResult } from "./api/createApp.js";
import { HttpAppNotifier } from "./adapters/notifier/AppNotifier.js";
import { ConsoleEmailSender } from "./adapters/email/EmailSender.js";
import { PrefeituraMariliaMockClient } from "./adapters/nfse/PrefeituraMariliaMockClient.js";
import { MockReconciliationGateway } from "./adapters/reconciliation/ReconciliationGateway.js";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { createSupabaseClient } from "./lib/supabaseClient.js";
import { InMemoryInvoiceRepository, type InvoiceRepository } from "./repositories/InvoiceRepository.js";
import { InMemoryPatientDoctorRepository, type PatientDoctorRepository } from "./repositories/PatientDoctorRepository.js";
import { SupabaseInvoiceRepository } from "./repositories/SupabaseInvoiceRepository.js";
import { SupabasePatientDoctorRepository } from "./repositories/SupabasePatientDoctorRepository.js";
import { InvoiceEmissionService } from "./services/InvoiceEmissionService.js";
import { ReconciliationService } from "./services/ReconciliationService.js";

const usingSupabase = Boolean(config.supabase.url && config.supabase.serviceRoleKey);

let invoiceRepository: InvoiceRepository;
let patientDoctorRepository: PatientDoctorRepository;
let auditTrail: InMemoryAuditTrail | SupabaseAuditTrail;
let healthCheck: () => Promise<HealthCheckResult>;

if (usingSupabase) {
  const supabase = createSupabaseClient(config.supabase.url!, config.supabase.serviceRoleKey!);
  invoiceRepository = new SupabaseInvoiceRepository(supabase);
  patientDoctorRepository = new SupabasePatientDoctorRepository(supabase);
  auditTrail = new SupabaseAuditTrail(supabase);
  healthCheck = async () => {
    const { error } = await supabase.from("patients").select("id").limit(1);
    return error ? { ok: false, details: `supabase: ${error.message}` } : { ok: true, details: "supabase reachable" };
  };
  logger.info("Persistencia real via Supabase", { url: config.supabase.url });
} else {
  invoiceRepository = new InMemoryInvoiceRepository();
  patientDoctorRepository = new InMemoryPatientDoctorRepository();
  auditTrail = new InMemoryAuditTrail();
  healthCheck = async () => ({ ok: true, details: "in-memory" });
  logger.info("Persistencia in-memory (defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para usar o Supabase real)");
}

const alertNotifier = new InMemoryAlertNotifier();
const metrics = new InMemoryMetrics();

const nfseClient = new PrefeituraMariliaMockClient({
  failureRate: config.nfse.mockFailureRate,
  latencyMs: config.nfse.mockLatencyMs,
});

const invoiceEmissionService = new InvoiceEmissionService({
  invoiceRepository,
  patientDoctorRepository,
  nfseClient,
  emailSender: new ConsoleEmailSender(),
  appNotifier: new HttpAppNotifier(config.appNotificationWebhookUrl),
  alertNotifier,
  auditTrail,
  metrics,
  retryOptions: config.retry,
  logger,
});

const reconciliationGateway = new MockReconciliationGateway();
const reconciliationService = new ReconciliationService({
  gateway: reconciliationGateway,
  invoiceRepository,
  invoiceEmissionService,
  alertNotifier,
});

const enableDebugRoutes = config.env !== "production";
if (!enableDebugRoutes) {
  logger.info("Rotas /debug/* desabilitadas (NODE_ENV=production)");
}
if (!config.security.adminApiKey) {
  logger.warn("ADMIN_API_KEY nao configurada — endpoints de consulta/debug ficam sem autenticacao (ok para uso local/demo)");
}

const app = createApp({
  invoiceEmissionService,
  invoiceRepository,
  nfseMockControl: nfseClient,
  alertFeed: alertNotifier,
  webhookSecurity: config.security,
  reconciliation: { service: reconciliationService, gateway: reconciliationGateway },
  recoveryDefaultThresholdMs: config.recovery.stuckInvoiceThresholdMs,
  auditTrail,
  metrics,
  adminApiKey: config.security.adminApiKey,
  enableDebugRoutes,
  healthCheck,
});

const server: Server = app.listen(config.port, () => {
  logger.info(`VYX NF agent ouvindo na porta ${config.port}`, { env: config.env });
});

const recoverySweep = setInterval(() => {
  invoiceEmissionService.recoverStuckInvoices(config.recovery.stuckInvoiceThresholdMs).catch((error) => {
    logger.error("recovery-sweep falhou", { error: String(error) });
  });
}, config.recovery.sweepIntervalMs);

const reconciliationTimer = setInterval(() => {
  reconciliationService.run().catch((error) => {
    logger.error("reconciliacao periodica falhou", { error: String(error) });
  });
}, config.reconciliation.intervalMs);

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Sinal ${signal} recebido, iniciando graceful shutdown`);

  clearInterval(recoverySweep);
  clearInterval(reconciliationTimer);

  server.close((err) => {
    if (err) logger.error("Erro ao fechar o servidor HTTP", { error: String(err) });
  });

  const { pendingAtTimeout } = await invoiceEmissionService.waitForIdle(5000);
  if (pendingAtTimeout > 0) {
    logger.warn(`Shutdown seguindo com ${pendingAtTimeout} emissao(oes) em background ainda pendente(s) apos o timeout`);
  } else {
    logger.info("Todas as emissoes em background terminaram, encerrando");
  }

  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
