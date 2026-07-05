import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeSignature } from "../../src/adapters/paymentGateway/stripeSignature.js";

const SECRET = "whsec_test_secret";

function signPayload(payload: string, timestamp: number, secret = SECRET): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

describe("verifyStripeSignature", () => {
  it("aceita uma assinatura valida e recente", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const header = signPayload(payload, Math.floor(Date.now() / 1000));
    expect(verifyStripeSignature(payload, header, SECRET)).toBe(true);
  });

  it("rejeita quando o payload foi alterado depois de assinado", () => {
    const header = signPayload(JSON.stringify({ id: "evt_1" }), Math.floor(Date.now() / 1000));
    expect(verifyStripeSignature(JSON.stringify({ id: "evt_2" }), header, SECRET)).toBe(false);
  });

  it("rejeita quando assinado com um segredo diferente", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const header = signPayload(payload, Math.floor(Date.now() / 1000), "whsec_outro");
    expect(verifyStripeSignature(payload, header, SECRET)).toBe(false);
  });

  it("rejeita timestamps fora da tolerancia (replay antigo)", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const oldTimestamp = Math.floor(Date.now() / 1000) - 3600;
    const header = signPayload(payload, oldTimestamp);
    expect(verifyStripeSignature(payload, header, SECRET)).toBe(false);
  });

  it("rejeita header ausente ou malformado", () => {
    expect(verifyStripeSignature("{}", undefined, SECRET)).toBe(false);
    expect(verifyStripeSignature("{}", "garbage-header", SECRET)).toBe(false);
  });
});
