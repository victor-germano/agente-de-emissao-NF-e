import { randomUUID } from "node:crypto";
import type { NFSeClient, NFSeEmissionRequest, NFSeEmissionResult } from "./NFSeClient.js";
import { NFSeEmissionError } from "./NFSeClient.js";

export interface PrefeituraMariliaMockClientOptions {
  /** Fracao entre 0 e 1 simulando indisponibilidade do site da prefeitura. */
  failureRate: number;
  latencyMs: number;
}

/**
 * Mock do webservice/site da Prefeitura de Marilia. Simula latencia de rede
 * e falhas intermitentes (ex: "prefeitura fora do ar" citado nos pontos em
 * aberto do documento), para que o restante do sistema possa ser testado sem
 * depender do sistema real.
 *
 * Para integrar de verdade, criar um outro `NFSeClient` (ex: chamando a API
 * oficial, ou automatizando via Playwright caso so exista o portal web) e
 * trocar a instancia usada em `src/index.ts` — nenhuma outra parte do
 * sistema muda.
 */
export class PrefeituraMariliaMockClient implements NFSeClient {
  private failureRate: number;
  private readonly latencyMs: number;

  constructor(options: PrefeituraMariliaMockClientOptions) {
    this.failureRate = options.failureRate;
    this.latencyMs = options.latencyMs;
  }

  /** Permite ajustar a taxa de falha em runtime (usado pelo painel de debug/demo). */
  setFailureRate(rate: number): void {
    this.failureRate = rate;
  }

  getFailureRate(): number {
    return this.failureRate;
  }

  async emit(request: NFSeEmissionRequest): Promise<NFSeEmissionResult> {
    await delay(this.latencyMs);

    if (Math.random() < this.failureRate) {
      throw new NFSeEmissionError(
        `Falha simulada ao emitir NFS-e para ${request.patientName} (site da prefeitura indisponivel ou rejeitou os dados)`,
      );
    }

    const nfseNumber = `MARILIA-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      nfseNumber,
      pdfUrl: `https://mock-prefeitura-marilia.example/nfse/${nfseNumber}.pdf`,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
