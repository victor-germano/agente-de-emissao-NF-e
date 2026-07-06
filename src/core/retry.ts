export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  /** Injetavel para testes; usa setTimeout por padrao. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryResult<T> {
  result: T;
  attempts: number;
}

/**
 * Erros que expoem `retryable: false` (ex: credencial invalida) interrompem
 * o retry imediatamente — retentar uma falha de autenticacao so desperdica
 * tempo/tentativas, ja que a mesma credencial errada nunca vai passar a
 * funcionar sozinha entre uma tentativa e outra.
 */
function isRetryable(error: unknown): boolean {
  return (error as { retryable?: boolean })?.retryable !== false;
}

/**
 * Anota quantas tentativas realmente aconteceram no proprio erro lancado,
 * para quem trata a falha (`InvoiceEmissionService`) poder registrar o
 * numero real em vez de assumir sempre `maxAttempts` — sem isso, uma falha
 * nao-retryable que so tentou 1 vez ficaria registrada como se tivesse
 * esgotado todas as tentativas.
 */
function attachAttempts(error: unknown, attempts: number): void {
  if (error && typeof error === "object") {
    (error as { attempts?: number }).attempts = attempts;
  }
}

/**
 * Executa `fn` com retentativa e backoff exponencial (baseDelay * 2^tentativa).
 * Cobre o ponto em aberto "formato de retentativa em caso de falha" do
 * documento. Relanca o ultimo erro (com `.attempts` anotado) apos esgotar
 * as tentativas, ou imediatamente se o erro nao for retryable.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<RetryResult<T>> {
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      const result = await fn(attempt);
      return { result, attempts: attempt };
    } catch (error) {
      const isLastAttempt = attempt === options.maxAttempts;
      if (isLastAttempt || !isRetryable(error)) {
        attachAttempts(error, attempt);
        throw error;
      }
      const delayMs = options.baseDelayMs * 2 ** (attempt - 1);
      await sleep(delayMs);
    }
  }

  /* c8 ignore next */
  throw new Error("withRetry: estado inalcancavel");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
