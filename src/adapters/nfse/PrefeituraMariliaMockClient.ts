import { randomUUID } from "node:crypto";
import type { NFSeClient, NFSeEmissionRequest, NFSeEmissionResult } from "./NFSeClient.js";
import { NFSeCancellationError, NFSeEmissionError } from "./NFSeClient.js";

export interface PrefeituraMariliaMockClientOptions {
  /** Fracao entre 0 e 1 simulando indisponibilidade do site da prefeitura. */
  failureRate: number;
  latencyMs: number;
  /**
   * Simula o token de API de um gateway de NFS-e real (ex: Focus NFe,
   * eNotas, NFE.io — que ja tem integracao pronta com Marilia via
   * login/senha na Sigiss por baixo dos panos, e expoem um token de API
   * simples pra quem consome). Se `undefined` (padrao), a checagem de
   * autenticacao e pulada — comportamento identico ao anterior, para nao
   * quebrar quem ja usa o mock sem token. Se configurado, todo `emit`/
   * `cancel` exige que o token bata com `SIMULATED_VALID_API_TOKEN`.
   */
  apiToken?: string;
}

/** Valor que o mock trata como "token de API valido" — documentado em .env.example. */
export const SIMULATED_VALID_API_TOKEN = "sandbox_focusnfe_demo_2026";

/**
 * Mock do webservice/site da Prefeitura de Marilia. Simula latencia de rede,
 * falhas intermitentes (ex: "prefeitura fora do ar" citado nos pontos em
 * aberto do documento) e, opcionalmente, autenticacao por token de API (ver
 * `apiToken` acima), para que o restante do sistema possa ser testado sem
 * depender do sistema real.
 *
 * Para integrar de verdade, criar um outro `NFSeClient` — seja chamando a
 * API oficial (se existir), automatizando via Playwright, ou (o caminho
 * mais comum na pratica) usando um gateway como Focus NFe/eNotas/NFE.io,
 * que ja tem Marilia integrada — e trocar a instancia usada em
 * `src/index.ts`. Nenhuma outra parte do sistema muda.
 */
export class PrefeituraMariliaMockClient implements NFSeClient {
  private failureRate: number;
  private readonly latencyMs: number;
  private apiToken: string | undefined;

  constructor(options: PrefeituraMariliaMockClientOptions) {
    this.failureRate = options.failureRate;
    this.latencyMs = options.latencyMs;
    this.apiToken = options.apiToken;
  }

  /** Permite ajustar a taxa de falha em runtime (usado pelo painel de debug/demo). */
  setFailureRate(rate: number): void {
    this.failureRate = rate;
  }

  getFailureRate(): number {
    return this.failureRate;
  }

  /** Permite ajustar o token simulado em runtime (usado pelo painel de debug/demo). */
  setApiToken(token: string | undefined): void {
    this.apiToken = token || undefined;
  }

  getApiToken(): string | undefined {
    return this.apiToken;
  }

  async emit(request: NFSeEmissionRequest): Promise<NFSeEmissionResult> {
    this.assertAuthenticated((message) => new NFSeEmissionError(message, undefined, false));
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

  async cancel(nfseNumber: string): Promise<void> {
    this.assertAuthenticated((message) => new NFSeCancellationError(message, undefined, false));
    await delay(this.latencyMs);

    if (Math.random() < this.failureRate) {
      throw new NFSeCancellationError(
        `Falha simulada ao cancelar NFS-e ${nfseNumber} (site da prefeitura indisponivel ou rejeitou o cancelamento)`,
      );
    }
  }

  private assertAuthenticated(makeError: (message: string) => Error): void {
    if (this.apiToken === undefined) return; // sem token configurado: checagem pulada (uso local/demo)
    if (this.apiToken !== SIMULATED_VALID_API_TOKEN) {
      // retryable: false — uma credencial invalida nao vira valida sozinha entre uma tentativa e outra.
      throw makeError(
        `401 Unauthorized: NFSE_API_TOKEN invalido ou ausente (simulando a autenticacao de um gateway real como Focus NFe/eNotas)`,
      );
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
