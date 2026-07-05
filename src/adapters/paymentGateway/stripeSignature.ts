import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Reimplementa o esquema real de assinatura de webhooks do Stripe
 * (header `Stripe-Signature: t=<timestamp>,v1=<hmac>`), para que a
 * verificacao aqui seja um drop-in real quando a chave secreta de producao
 * for configurada — nao apenas um placeholder.
 *
 * https://docs.stripe.com/webhooks#verify-official-libraries (esquema v1)
 */
export function verifyStripeSignature(
  payload: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  if (!signatureHeader) return false;

  const parts = new Map(
    signatureHeader
      .split(",")
      .map((part) => part.split("="))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([key, value]) => [key.trim(), value.trim()]),
  );

  const timestamp = parts.get("t");
  const expectedSignature = parts.get("v1");
  if (!timestamp || !expectedSignature) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > toleranceSeconds) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const computedSignature = createHmac("sha256", secret).update(signedPayload).digest("hex");

  const expected = Buffer.from(expectedSignature, "utf8");
  const computed = Buffer.from(computedSignature, "utf8");
  if (expected.length !== computed.length) return false;

  return timingSafeEqual(expected, computed);
}
