import { describe, expect, it } from "vitest";
import { PrefeituraMariliaMockClient, SIMULATED_VALID_API_TOKEN } from "../../src/adapters/nfse/PrefeituraMariliaMockClient.js";

const REQUEST = {
  patientName: "Ana Souza",
  patientCpf: "111.111.111-11",
  doctorName: "Dr. Carlos Lima",
  amountCents: 10000,
  description: "Atendimento medico",
};

describe("PrefeituraMariliaMockClient — token de API simulado", () => {
  it("funciona normalmente quando nenhum token e configurado (compatibilidade com uso existente)", async () => {
    const client = new PrefeituraMariliaMockClient({ failureRate: 0, latencyMs: 0 });
    const result = await client.emit(REQUEST);
    expect(result.nfseNumber).toBeDefined();
    await expect(client.cancel(result.nfseNumber)).resolves.toBeUndefined();
  });

  it("funciona quando o token configurado e o valido", async () => {
    const client = new PrefeituraMariliaMockClient({ failureRate: 0, latencyMs: 0, apiToken: SIMULATED_VALID_API_TOKEN });
    const result = await client.emit(REQUEST);
    expect(result.nfseNumber).toBeDefined();
  });

  it("rejeita emit/cancel com erro de autenticacao quando o token e invalido", async () => {
    const client = new PrefeituraMariliaMockClient({ failureRate: 0, latencyMs: 0, apiToken: "token-errado" });
    await expect(client.emit(REQUEST)).rejects.toThrow(/401|autenticacao|token/i);
    await expect(client.cancel("MARILIA-2026-TEST")).rejects.toThrow(/401|autenticacao|token/i);
  });

  it("marca o erro de autenticacao como nao-retryable (retentar nao adianta com credencial errada)", async () => {
    const client = new PrefeituraMariliaMockClient({ failureRate: 0, latencyMs: 0, apiToken: "token-errado" });
    await expect(client.emit(REQUEST)).rejects.toMatchObject({ retryable: false });
    await expect(client.cancel("MARILIA-2026-TEST")).rejects.toMatchObject({ retryable: false });
  });

  it("setApiToken/getApiToken permitem ajustar em runtime (debug/demo)", async () => {
    const client = new PrefeituraMariliaMockClient({ failureRate: 0, latencyMs: 0 });
    expect(client.getApiToken()).toBeUndefined();

    client.setApiToken("errado");
    await expect(client.emit(REQUEST)).rejects.toThrow();

    client.setApiToken(SIMULATED_VALID_API_TOKEN);
    await expect(client.emit(REQUEST)).resolves.toBeDefined();

    client.setApiToken(undefined);
    expect(client.getApiToken()).toBeUndefined();
  });
});
