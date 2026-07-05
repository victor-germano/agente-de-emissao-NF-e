export interface NFSeEmissionRequest {
  patientName: string;
  patientCpf: string;
  doctorName: string;
  amountCents: number;
  description: string;
}

export interface NFSeEmissionResult {
  nfseNumber: string;
  pdfUrl: string;
}

/**
 * Contrato de integracao com o emissor de NFS-e da Prefeitura de Marilia.
 *
 * Ponto em aberto do documento (secao 3): nao se sabe ainda se existe API
 * oficial ou se sera necessario RPA/navegador headless. Esta interface isola
 * essa decisao — o resto do sistema so depende de `emit`, entao qualquer uma
 * das duas abordagens pode ser implementada aqui sem tocar no restante do
 * codigo.
 */
export interface NFSeClient {
  emit(request: NFSeEmissionRequest): Promise<NFSeEmissionResult>;
  /** Cancela uma NFS-e ja emitida (ex: pagamento estornado/reembolsado). */
  cancel(nfseNumber: string): Promise<void>;
}

export class NFSeEmissionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "NFSeEmissionError";
  }
}

export class NFSeCancellationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "NFSeCancellationError";
  }
}
