import { z } from "zod";

/**
 * Formato simplificado de um evento "payment succeeded" do Stripe.
 * Reduzido aos campos que o agente realmente precisa.
 */
export const StripePaymentSucceededSchema = z.object({
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

export type StripePaymentSucceededEvent = z.infer<typeof StripePaymentSucceededSchema>;

/**
 * Evento de estorno/reembolso do Stripe. `payment_intent` referencia o
 * pagamento original — usado para localizar a invoice ja emitida e
 * cancela-la (item "cancelamento/estorno" nao coberto pelo documento
 * original, mas necessario para uma automacao completa).
 */
export const StripeChargeRefundedSchema = z.object({
  id: z.string(),
  type: z.literal("charge.refunded"),
  data: z.object({
    object: z.object({
      payment_intent: z.string(),
      created: z.number().int().optional(),
    }),
  }),
});

export type StripeChargeRefundedEvent = z.infer<typeof StripeChargeRefundedSchema>;

export const StripeEventSchema = z.discriminatedUnion("type", [StripePaymentSucceededSchema, StripeChargeRefundedSchema]);

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
