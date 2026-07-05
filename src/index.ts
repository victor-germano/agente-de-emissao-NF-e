import { InMemoryAlertNotifier } from "./adapters/alerting/AlertNotifier.js";
import { InMemoryAuditTrail } from "./adapters/audit/AuditTrail.js";
import { SupabaseAuditTrail } from "./adapters/audit/SupabaseAuditTrail.js";
import { InMemoryMetrics } from "./adapters/metrics/Metrics.js";
import { createApp } from "./api/createApp.js";
import { HttpAppNotifier } from "./adapters/notifier/AppNotifier.js";
import { ConsoleEmailSender } from "./adapters/email/EmailSender.js";
import { PrefeituraMariliaMockClient } from "./adapters/nfse/PrefeituraMariliaMockClient.js";
import { MockReconciliationGateway } from "./adapters/reconciliation/ReconciliationGateway.js";
import { config } from "./config.js";
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

if (usingSupabase) {
  const supabase = createSupabaseClient(config.supabase.url!, config.supabase.serviceRoleKey!);
  invoiceRepository = new SupabaseInvoiceRepository(supabase);
  patientDoctorRepository = new SupabasePatientDoctorRepository(supabase);
  auditTrail = new SupabaseAuditTrail(supabase);
  console.log(`[startup] Persistencia real via Supabase (${config.supabase.url})`);
} else {
  invoiceRepository = new InMemoryInvoiceRepository();
  patientDoctorRepository = new InMemoryPatientDoctorRepository();
  auditTrail = new InMemoryAuditTrail();
  console.log("[startup] Persistencia in-memory (defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para usar o Supabase real)");
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
});

const reconciliationGateway = new MockReconciliationGateway();
const reconciliationService = new ReconciliationService({
  gateway: reconciliationGateway,
  invoiceRepository,
  invoiceEmissionService,
  alertNotifier,
});

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
});

app.listen(config.port, () => {
  console.log(`VYX NF agent ouvindo na porta ${config.port}`);
});

setInterval(() => {
  invoiceEmissionService.recoverStuckInvoices(config.recovery.stuckInvoiceThresholdMs).catch((error) => {
    console.error("[recovery-sweep] falhou:", error);
  });
}, config.recovery.sweepIntervalMs);

setInterval(() => {
  reconciliationService.run().catch((error) => {
    console.error("[reconciliation] falhou:", error);
  });
}, config.reconciliation.intervalMs);
