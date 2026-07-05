import { InMemoryAlertNotifier } from "./adapters/alerting/AlertNotifier.js";
import { createApp } from "./api/createApp.js";
import { HttpAppNotifier } from "./adapters/notifier/AppNotifier.js";
import { ConsoleEmailSender } from "./adapters/email/EmailSender.js";
import { PrefeituraMariliaMockClient } from "./adapters/nfse/PrefeituraMariliaMockClient.js";
import { MockReconciliationGateway } from "./adapters/reconciliation/ReconciliationGateway.js";
import { config } from "./config.js";
import { InMemoryInvoiceRepository } from "./repositories/InvoiceRepository.js";
import { InMemoryPatientDoctorRepository } from "./repositories/PatientDoctorRepository.js";
import { InvoiceEmissionService } from "./services/InvoiceEmissionService.js";
import { ReconciliationService } from "./services/ReconciliationService.js";

const invoiceRepository = new InMemoryInvoiceRepository();
const patientDoctorRepository = new InMemoryPatientDoctorRepository();
const alertNotifier = new InMemoryAlertNotifier();

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
