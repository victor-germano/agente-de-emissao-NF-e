import { randomUUID } from "node:crypto";
import type { NFSeClient, NFSeEmissionRequest, NFSeEmissionResult } from "./NFSeClient.js";
import { NFSeCancellationError, NFSeEmissionError } from "./NFSeClient.js";

export interface PrefeituraMariliaMockClientOptions {
  /** Fracao entre 0 e 1 simulando indisponibilidade do site da prefeitura. */
  failureRate: number;
  latencyMs: number;
  /**
   * Simula o token de acesso da Focus NFe — pesquisado e verificado (nao
   * suposto): a API real usa HTTP Basic Auth onde o "usuario" e o token da
   * empresa e a senha fica em branco (`Authorization: Basic
   * base64(token+":")`), com URLs separadas para homologacao
   * (homologacao.focusnfe.com.br, gratis e ilimitado) e producao
   * (api.focusnfe.com.br) — ver doc.focusnfe.com.br/reference/autenticacao.
   * A Focus confirma Marilia/Sigiss especificamente (mapeamento de campos,
   * NBS, retencao PIS/COFINS/CSLL) em focusnfe.com.br/blog (ver README).
   *
   * Se `undefined` (padrao), a checagem de autenticacao e pulada — uso
   * local/demo. Se configurado, todo `emit`/`cancel` exige que o token bata
   * com `SIMULATED_VALID_API_TOKEN`.
   *
   * Alternativa pesquisada e documentada mas NAO implementada aqui:
   * integrar direto no webservice SOAP da Sigiss
   * (marilia.sigiss.com.br/marilia/ws/sigiss_ws.php?wsdl, metodos
   * GerarNota/CancelarNota/ConsultarNotaValida). Essa API oficial nao usa
   * token nem certificado para autenticar a chamada - usa CCM + CNPJ + senha
   * do prestador dentro do proprio payload SOAP (certificado digital e
   * opcional, so pra assinar o XML resultante), e ja tem um campo nativo de
   * idempotencia (`id_sis_legado`) equivalente ao nosso
   * `paymentExternalId`. O manual oficial encontrado e de 2012 e a cidade
   * esta em transicao para o padrao nacional de NFS-e (LC 214/2025,
   * obrigatorio desde 01/01/2026) — integrar direto contra essa API legada
   * tem risco real de quebrar quando essa transicao terminar.
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
 * Para integrar de verdade (recomendacao pesquisada, nao um chute): criar um
 * `FocusNfeClient implements NFSeClient` que chama
 * https://api.focusnfe.com.br (ou homologacao.focusnfe.com.br para testar)
 * com HTTP Basic Auth (token como usuario, senha em branco), e trocar a
 * instancia usada em `src/index.ts`. Nenhuma outra parte do sistema muda.
 * Integrar direto na Sigiss (SOAP, sem gateway) tambem e possivel e esta
 * documentado acima, mas carrega o risco de manutencao de acompanhar a
 * transicao pro padrao nacional de NFS-e por conta propria.
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
