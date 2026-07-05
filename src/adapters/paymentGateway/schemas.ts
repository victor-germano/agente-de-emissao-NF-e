import { z } from "zod";

/**
 * Formato simplificado de um evento "charge/payment succeeded" do Stripe.
 * Reduzido aos campos que o agente realmente precisa.
 */
export const StripeEventSchema = z.object({
  id: z.string(),
  type: z.literal("payment_intent.succeeded"),
  data: z.object({
    object: z.object({
      id: z.string(),
      amount: z.number().int().positive(),
      currency: z.string().default("brl"),
      metadata: z.object({
        patient_id: z.string(),
      }),
      created: z.number().int().optional(),
    }),
  }),
});

export type StripeEvent = z.infer<typeof StripeEventSchema>;

/**
 * Payload do "segundo gateway" (Pix / cartao parcelado), hoje inserido
 * manualmente no Notion (secao 3.1 do AS-IS). Aqui modelamos o formato que
 * uma integracao futura enviaria, conforme apontado no TO-BE ("proximo passo
 * futuro: automatizar o segundo gateway de pagamento").
 */
export const SecondGatewayEventSchema = z.object({
  transactionId: z.string(),
  method: z.enum(["pix", "cartao_parcelado"]),
  patientId: z.string(),
  amountCents: z.number().int().positive(),
  paidAt: z.string(),
});

export type SecondGatewayEvent = z.infer<typeof SecondGatewayEventSchema>;
