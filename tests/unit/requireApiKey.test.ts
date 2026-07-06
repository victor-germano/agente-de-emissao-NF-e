import { describe, expect, it, vi } from "vitest";
import { requireApiKey } from "../../src/api/requireApiKey.js";

function fakeReq(authHeader?: string) {
  return { header: (name: string) => (name.toLowerCase() === "authorization" ? authHeader : undefined) } as any;
}

function fakeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("requireApiKey", () => {
  it("e passthrough quando nenhuma chave e configurada", () => {
    const middleware = requireApiKey(undefined);
    const next = vi.fn();
    middleware(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejeita com 401 quando o header esta ausente", () => {
    const middleware = requireApiKey("secret-key");
    const res = fakeRes();
    const next = vi.fn();
    middleware(fakeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejeita com 401 quando o token esta incorreto", () => {
    const middleware = requireApiKey("secret-key");
    const res = fakeRes();
    const next = vi.fn();
    middleware(fakeReq("Bearer wrong-token"), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("chama next quando o token esta correto", () => {
    const middleware = requireApiKey("secret-key");
    const res = fakeRes();
    const next = vi.fn();
    middleware(fakeReq("Bearer secret-key"), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
