import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { normalizeSecondGatewayEvent, normalizeStripeEvent } from "../adapters/paymentGateway/normalize.js";
import { SecondGatewayEventSchema, StripeEventSchema } from "../adapters/paymentGateway/schemas.js";
import type { InvoiceEmissionService } from "../services/InvoiceEmissionService.js";
import type { InvoiceRepository } from "../repositories/InvoiceRepository.js";

export interface NFSeMockControl {
  getFailureRate(): number;
  setFailureRate(rate: number): void;
}

export interface CreateAppDeps {
  invoiceEmissionService: InvoiceEmissionService;
  invoiceRepository: InvoiceRepository;
  /** Se presente, habilita o painel/endpoints de debug do mock da prefeitura (uso local/demo). */
  nfseMockControl?: NFSeMockControl;
}

const FailureRateSchema = z.object({ rate: z.number().min(0).max(1) });

export function createApp(deps: CreateAppDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), "public")));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (deps.nfseMockControl) {
    const control = deps.nfseMockControl;

    app.get("/debug/nfse-failure-rate", (_req, res) => {
      res.json({ rate: control.getFailureRate() });
    });

    app.post("/debug/nfse-failure-rate", asyncHandler(async (req, res) => {
      const { rate } = FailureRateSchema.parse(req.body);
      control.setFailureRate(rate);
      res.json({ rate });
    }));
  }

  // Etapas 1-2 do TO-BE: transacao no Stripe chega via webhook.
  app.post("/webhooks/stripe", asyncHandler(async (req, res) => {
    const event = StripeEventSchema.parse(req.body);
    const invoice = await deps.invoiceEmissionService.processPayment(normalizeStripeEvent(event));
    res.status(202).json(invoice);
  }));

  // Etapa 1 do TO-BE ("futuramente tambem no segundo gateway, para Pix/parcelado").
  app.post("/webhooks/gateway2", asyncHandler(async (req, res) => {
    const event = SecondGatewayEventSchema.parse(req.body);
    const invoice = await deps.invoiceEmissionService.processPayment(normalizeSecondGatewayEvent(event));
    res.status(202).json(invoice);
  }));

  // Endpoint de mock para receber a notificacao de webhook do proprio App (uso local/demo).
  app.post("/mock/app-webhook", (req, res) => {
    console.log("[mock-app-webhook] recebido:", req.body);
    res.status(200).json({ received: true });
  });

  app.get("/invoices", asyncHandler(async (_req, res) => {
    res.json(await deps.invoiceRepository.list());
  }));

  app.get("/invoices/failed", asyncHandler(async (_req, res) => {
    res.json(await deps.invoiceRepository.listByStatus("failed"));
  }));

  app.get("/invoices/:id", asyncHandler(async (req, res) => {
    const invoice = await deps.invoiceRepository.findById(req.params.id ?? "");
    if (!invoice) {
      res.status(404).json({ error: "invoice not found" });
      return;
    }
    res.json(invoice);
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "invalid payload", details: err.issues });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
