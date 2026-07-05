import { createApp } from "./api/createApp.js";
import { HttpAppNotifier } from "./adapters/notifier/AppNotifier.js";
import { ConsoleEmailSender } from "./adapters/email/EmailSender.js";
import { PrefeituraMariliaMockClient } from "./adapters/nfse/PrefeituraMariliaMockClient.js";
import { config } from "./config.js";
import { InMemoryInvoiceRepository } from "./repositories/InvoiceRepository.js";
import { InMemoryPatientDoctorRepository } from "./repositories/PatientDoctorRepository.js";
import { InvoiceEmissionService } from "./services/InvoiceEmissionService.js";

const invoiceRepository = new InMemoryInvoiceRepository();
const patientDoctorRepository = new InMemoryPatientDoctorRepository();

const invoiceEmissionService = new InvoiceEmissionService({
  invoiceRepository,
  patientDoctorRepository,
  nfseClient: new PrefeituraMariliaMockClient({
    failureRate: config.nfse.mockFailureRate,
    latencyMs: config.nfse.mockLatencyMs,
  }),
  emailSender: new ConsoleEmailSender(),
  appNotifier: new HttpAppNotifier(config.appNotificationWebhookUrl),
  retryOptions: config.retry,
});

const app = createApp({ invoiceEmissionService, invoiceRepository });

app.listen(config.port, () => {
  console.log(`VYX NF agent ouvindo na porta ${config.port}`);
});
