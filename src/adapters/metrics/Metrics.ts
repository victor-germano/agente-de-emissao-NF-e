export interface DurationSnapshot {
  count: number;
  avgMs: number;
  maxMs: number;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  durations: Record<string, DurationSnapshot>;
}

/**
 * Observabilidade basica: quantas notas foram emitidas/falharam/canceladas/
 * recuperadas, e quanto tempo a emissao leva. Nao esta no documento
 * original, mas sem isso ninguem sabe se a automacao esta saudavel sem
 * esperar um alerta de falha disparar — util para um dashboard operacional.
 */
export interface Metrics {
  increment(counter: string): void;
  observeDurationMs(name: string, ms: number): void;
  snapshot(): MetricsSnapshot;
}

interface DurationAccumulator {
  count: number;
  totalMs: number;
  maxMs: number;
}

/** Em producao, trocar por um client real (ex: prom-client) — mesma interface. */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, DurationAccumulator>();

  increment(counter: string): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + 1);
  }

  observeDurationMs(name: string, ms: number): void {
    const acc = this.durations.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    acc.count += 1;
    acc.totalMs += ms;
    acc.maxMs = Math.max(acc.maxMs, ms);
    this.durations.set(name, acc);
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [key, value] of this.counters) counters[key] = value;

    const durations: Record<string, DurationSnapshot> = {};
    for (const [key, acc] of this.durations) {
      durations[key] = { count: acc.count, avgMs: Math.round(acc.totalMs / acc.count), maxMs: acc.maxMs };
    }

    return { counters, durations };
  }
}
