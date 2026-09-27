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

// Em producao, subir sem essas variaveis e um risco de seguranca real, nao um detalhe:
// sem ADMIN_API_KEY, /invoices expoe CPF/e-mail de paciente sem autenticacao; sem
// STRIPE_WEBHOOK_SECRET, qualquer um pode forjar um "pagamento aprovado" e ganhar uma
// nota fiscal de graca. Falhar rapido aqui e melhor que descobrir isso depois do deploy.
if (config.env === "production") {
  const missing: string[] = [];
  if (!config.security.adminApiKey) missing.push("ADMIN_API_KEY");
  if (!config.security.stripeWebhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
  if (missing.length > 0) {
    throw new Error(
      `NODE_ENV=production mas variaveis obrigatorias de seguranca nao configuradas: ${missing.join(", ")}.`,
    );
  }
}

const usingSupabase = Boolean(config.supabase.url && config.supabase.serviceRoleKey);

let invoiceRepository: InvoiceRepository;
let patientDoctorRepository: PatientDoctorRepository;
let auditTrail: InMemoryAuditTrail | SupabaseAuditTrail;
let healthCheck: () => Promise<HealthCheckResult>;

/**
 * Sinal de saude generico (nao depende de Supabase vs memoria): notas presas em
 * "processing" ha muito mais tempo do que o normal deveriam ter sido pegas pela
 * varredura de recuperacao - se nao foram, algo esta errado (varredura parada,
 * NFSeClient travando sem lancar erro, etc), e o health check deve refletir isso em vez
 * de responder "ok" sempre.
 */
async function checkStuckInvoices(): Promise<{ ok: boolean; stuckCount: number }> {
  const staleThresholdMs = config.recovery.stuckInvoiceThresholdMs * 3;
  const stuck = (await invoiceRepository.listByStatus("processing")).filter(
    (invoice) => Date.now() - new Date(invoice.updatedAt).getTime() >= staleThresholdMs,
  );
  return { ok: stuck.length === 0, stuckCount: stuck.length };
}

if (usingSupabase) {
  const supabase = createSupabaseClient(config.supabase.url!, config.supabase.serviceRoleKey!);
  invoiceRepository = new SupabaseInvoiceRepository(supabase);
  patientDoctorRepository = new SupabasePatientDoctorRepository(supabase);
  auditTrail = new SupabaseAuditTrail(supabase);
  healthCheck = async () => {
    const [{ error }, stuck] = await Promise.all([
      supabase.from("patients").select("id").limit(1),
      checkStuckInvoices(),
    ]);
    if (error) return { ok: false, details: `supabase: ${error.message}` };
    return {
      ok: stuck.ok,
      details: `supabase reachable; notas travadas ha muito tempo: ${stuck.stuckCount}`,
    };
  };
  logger.info("Persistencia real via Supabase", { url: config.supabase.url });
} else {
  invoiceRepository = new InMemoryInvoiceRepository();
  patientDoctorRepository = new InMemoryPatientDoctorRepository();
  auditTrail = new InMemoryAuditTrail();
  healthCheck = async () => {
    const stuck = await checkStuckInvoices();
    return { ok: stuck.ok, details: `in-memory; notas travadas ha muito tempo: ${stuck.stuckCount}` };
  };
  logger.info("Persistencia in-memory (defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para usar o Supabase real)");
}

const alertNotifier = new InMemoryAlertNotifier();
const metrics = new InMemoryMetrics();

const nfseClient = new PrefeituraMariliaMockClient({
  failureRate: config.nfse.mockFailureRate,
  latencyMs: config.nfse.mockLatencyMs,
  apiToken: config.nfse.apiToken,
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
  emissionSlaMs: config.emissionSlaMs,
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

  // Para de aceitar novas conexoes e espera as existentes fecharem sozinhas - mas com um
  // teto: uma conexao HTTP keep-alive parada pode fazer server.close() nunca chamar seu
  // callback, e um shutdown que nunca termina e pior do que um shutdown que forca a
  // saida depois de um tempo razoavel.
  const HTTP_DRAIN_TIMEOUT_MS = 5000;
  const closeServer = new Promise<void>((resolve) => {
    server.close((err) => {
      if (err) logger.error("Erro ao fechar o servidor HTTP", { error: String(err) });
      resolve();
    });
  });
  const drainResult = await Promise.race([
    closeServer.then(() => "closed" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), HTTP_DRAIN_TIMEOUT_MS)),
  ]);
  if (drainResult === "timeout") {
    logger.warn(
      `Servidor HTTP nao terminou de fechar todas as conexoes em ${HTTP_DRAIN_TIMEOUT_MS}ms (provavelmente uma conexao keep-alive parada) - seguindo com o shutdown mesmo assim`,
    );
  } else {
    logger.info("Servidor HTTP parou de aceitar novas conexoes e as existentes foram encerradas");
  }

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
