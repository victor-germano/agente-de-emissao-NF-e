import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Protege endpoints de consulta/operacao (invoices, alertas, metricas,
 * debug, reconciliacao) contra acesso nao autenticado — sem isso, qualquer
 * um que alcance o servidor le dados de paciente (CPF, e-mail) ou dispara
 * acoes de simulacao. Se `apiKey` nao estiver configurada, vira passthrough
 * (conveniente para rodar o painel local/demo sem precisar de token).
 */
export function requireApiKey(apiKey: string | undefined): RequestHandler {
  if (!apiKey) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token || !safeEqual(token, apiKey)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
