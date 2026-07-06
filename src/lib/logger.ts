export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Logger estruturado (uma linha JSON por evento) para que os logs sejam
 * consumiveis por uma ferramenta de observabilidade real (Datadog, ELK,
 * CloudWatch Logs Insights) em vez de texto solto. Implementa o mesmo
 * shape (`Pick<Console, "info"|"warn"|"error">`) que os servicos ja
 * esperavam, entao nao muda nenhuma assinatura existente.
 */
function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, message, context, timestamp: new Date().toISOString() });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger: Logger = {
  info: (message, context) => log("info", message, context),
  warn: (message, context) => log("warn", message, context),
  error: (message, context) => log("error", message, context),
};
