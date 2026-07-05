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
 * Executa `fn` com retentativa e backoff exponencial (baseDelay * 2^tentativa).
 * Cobre o ponto em aberto "formato de retentativa em caso de falha" do
 * documento. Relanca o ultimo erro apos esgotar as tentativas.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<RetryResult<T>> {
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      const result = await fn(attempt);
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === options.maxAttempts;
      if (!isLastAttempt) {
        const delayMs = options.baseDelayMs * 2 ** (attempt - 1);
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
