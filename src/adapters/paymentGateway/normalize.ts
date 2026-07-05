import type { PaymentEvent, PaymentRefundEvent } from "../../domain/models.js";
import type { SecondGatewayEvent, StripeChargeRefundedEvent, StripePaymentSucceededEvent } from "./schemas.js";

export function normalizeStripeEvent(event: StripePaymentSucceededEvent): PaymentEvent {
  const object = event.data.object;
  return {
    externalId: object.id,
    source: "stripe",
    patientId: object.metadata.patient_id,
    amountCents: object.amount,
    currency: object.currency,
    occurredAt: object.created ? new Date(object.created * 1000).toISOString() : new Date().toISOString(),
  };
}

export function normalizeStripeRefundEvent(event: StripeChargeRefundedEvent): PaymentRefundEvent {
  const object = event.data.object;
  return {
    paymentExternalId: object.payment_intent,
    occurredAt: object.created ? new Date(object.created * 1000).toISOString() : new Date().toISOString(),
  };
}

export function normalizeSecondGatewayEvent(event: SecondGatewayEvent): PaymentEvent {
  return {
    externalId: event.transactionId,
    source: "gateway2_pix_parcelado",
    patientId: event.patientId,
    amountCents: event.amountCents,
    currency: "brl",
    occurredAt: event.paidAt,
  };
}
