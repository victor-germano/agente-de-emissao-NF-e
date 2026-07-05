import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../../src/core/retry.js";

describe("withRetry", () => {
  it("retorna no primeiro sucesso sem retentativa", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const { result, attempts } = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} });
    expect(result).toBe("ok");
    expect(attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("tenta novamente ate ter sucesso, respeitando maxAttempts", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("falha 1"))
      .mockRejectedValueOnce(new Error("falha 2"))
      .mockResolvedValue("ok");

    const sleep = vi.fn().mockResolvedValue(undefined);
    const { result, attempts } = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, sleep });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("relanca o ultimo erro apos esgotar as tentativas", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("sempre falha"));
    await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} })).rejects.toThrow("sempre falha");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
