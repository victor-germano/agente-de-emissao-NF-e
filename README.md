# Agente de emissão de Notas Fiscais — VYX

Protótipo do agente que implementa o fluxo **TO-BE** descrito em
`Processo de Emissão de Notas Fiscais — VYX`: recebe o evento de
pagamento, associa automaticamente paciente + médico, emite a NFS-e junto
à Prefeitura de Marília, envia o PDF por e-mail e notifica o App.

## Por que tudo mockado nas bordas

Este é um teste técnico, sem credenciais reais de Stripe/Supabase/Prefeitura
de Marília. Em vez de simular uma integração real com dados falsos, o
sistema foi desenhado com **interfaces (ports) explícitas** em cada ponto de
integração externa (`NFSeClient`, `EmailSender`, `AppNotifier`,
`PatientDoctorRepository`, `InvoiceRepository`). Hoje cada uma tem uma
implementação mock/in-memory; trocar por uma integração real é implementar
a interface e injetar em `src/index.ts` — nenhuma outra parte do sistema
muda. Essa é a decisão de arquitetura mais importante do projeto.

## Fluxo implementado (TO-BE)

```
POST /webhooks/stripe            POST /webhooks/gateway2 (Pix/parcelado)
        │                                     │
        └───────────────┬─────────────────────┘
                         ▼
              normaliza para PaymentEvent
                         ▼
          InvoiceEmissionService.processPayment
                         │
        ┌────────────────┼─────────────────────┐
        ▼                ▼                     ▼
  idempotência    associa paciente+médico   cria Invoice "processing"
 (por externalId)  (PatientDoctorRepository)
                         │
                         ▼
       NFSeClient.emit()  com retry/backoff exponencial
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
         sucesso: "issued"     falhas esgotadas: "failed"
              │                (lastError registrado p/ auditoria)
              ▼
     EmailSender + AppNotifier (falhas aqui não revertem a nota)
```

## Mapeamento com o documento

| Etapa do TO-BE | Implementação |
|---|---|
| 1-2. Stripe / 2º gateway → App | `POST /webhooks/stripe` e `POST /webhooks/gateway2`, cada um com seu parser (`src/adapters/paymentGateway`) normalizando para `PaymentEvent` |
| 3. Associação automática médico+valor | `PatientDoctorRepository.findLastDoctorForPatient` (hoje in-memory; ver seção abaixo para Supabase) |
| 4. Disparo da emissão | `InvoiceEmissionService` chama `NFSeClient.emit` |
| 4 (integração c/ prefeitura) | `NFSeClient` — interface; `PrefeituraMariliaMockClient` simula latência e falhas |
| 5. Nota (PDF) retorna e reflete no sistema | `Invoice.pdfUrl` / `Invoice.nfseNumber` persistidos via `InvoiceRepository` |
| 6. E-mail automático ao paciente | `EmailSender` (`ConsoleEmailSender` no protótipo) |
| 7. Notificação webhook "nota disponível" | `AppNotifier` (`HttpAppNotifier`, faz POST se `APP_NOTIFICATION_WEBHOOK_URL` estiver configurada) |
| 8. Financeiro sai da operação manual | Não há nenhum passo manual no fluxo feliz; falhas ficam visíveis em `GET /invoices/failed` para intervenção pontual |

## Pontos em aberto do documento — como foram tratados

- **API oficial vs RPA/headless para a Prefeitura de Marília**: isolado atrás
  de `NFSeClient`. Não decidido no código porque depende de descoberta real
  (a Prefeitura de Marília usa uma plataforma de terceiros para NFS-e —
  precisa confirmar se expõe webservice/API antes de escolher).
- **Fallback/erro na emissão**: `withRetry` (`src/core/retry.ts`) faz até
  `NFSE_RETRY_MAX_ATTEMPTS` tentativas com backoff exponencial. Se todas
  falharem, a invoice fica com `status: "failed"` e `lastError`, visível em
  `GET /invoices/failed` — pronto para virar um alerta (Slack/e-mail) real.
- **Dados inconsistentes** (paciente sem médico associado, paciente
  inexistente): a invoice é criada com `status: "failed"` e motivo
  registrado, em vez de lançar exceção silenciosa.
- **Idempotência**: cada `PaymentEvent.externalId` só gera uma invoice —
  reprocessar o mesmo webhook (comum em retries de gateways de pagamento)
  não duplica a nota.
- **Segundo gateway (Pix/parcelado)**: modelado como um endpoint e schema
  próprios (`POST /webhooks/gateway2`), já usando o mesmo pipeline —
  quando esse gateway existir de fato, é só apontar o webhook dele para essa
  rota.

## Rodando localmente

```bash
npm install
cp .env.example .env
npm run dev        # http://localhost:3000
```

Simular um pagamento Stripe:

```bash
curl -X POST http://localhost:3000/webhooks/stripe \
  -H 'content-type: application/json' \
  -d '{
    "id": "evt_1",
    "type": "payment_intent.succeeded",
    "data": { "object": {
      "id": "pi_123", "amount": 20000, "currency": "brl",
      "metadata": { "patient_id": "pat_1" }
    }}
  }'
```

Simular um pagamento Pix (segundo gateway):

```bash
curl -X POST http://localhost:3000/webhooks/gateway2 \
  -H 'content-type: application/json' \
  -d '{
    "transactionId": "pix_1", "method": "pix",
    "patientId": "pat_2", "amountCents": 15000,
    "paidAt": "2026-07-05T12:00:00Z"
  }'
```

Consultar: `GET /invoices`, `GET /invoices/:id`, `GET /invoices/failed`.

Para testar o cenário de falha/retry, ajuste `NFSE_MOCK_FAILURE_RATE` no
`.env` (ex: `0.5`) e observe os `attempts` na resposta.

Pacientes/médicos de exemplo (seed in-memory, ver
`src/repositories/PatientDoctorRepository.ts`): `pat_1` (Ana Souza / Dr.
Carlos Lima) e `pat_2` (Bruno Alves / Dra. Fernanda Rocha).

## Testes

```bash
npm run typecheck
npm test
```

Cobrem: retry/backoff, associação automática médico+paciente, idempotência,
emissão com falha transitória seguida de sucesso, falha após esgotar
tentativas, dados inconsistentes, e os dois webhooks HTTP fim a fim.

## Como plugar as integrações reais

- **Supabase**: implementar `PatientDoctorRepository` e `InvoiceRepository`
  usando `@supabase/supabase-js` (tabelas `patients`, `doctors`,
  `consultations`, `invoices`), reaproveitando as variáveis já previstas em
  `.env.example` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), e trocar a
  instância em `src/index.ts`.
- **Stripe real**: trocar o parser mock por verificação de assinatura do
  webhook (`stripe.webhooks.constructEvent`) antes de normalizar o evento.
- **Prefeitura de Marília real**: nova implementação de `NFSeClient` — API
  oficial (se existir) ou automação via Playwright contra o portal web,
  mantendo a mesma assinatura `emit(request): Promise<NFSeEmissionResult>`.
- **E-mail real**: trocar `ConsoleEmailSender` por um provedor
  (SES/SendGrid/SMTP) implementando `EmailSender`.

## Não incluído (fora do escopo deste protótipo)

- Automação do segundo gateway de pagamento em produção (o endpoint já
  existe; falta a integração real, item citado no documento como "próximo
  passo futuro").
- Persistência real (Postgres/Supabase) — hoje in-memory, reiniciar o
  processo limpa os dados.
- Autenticação/autorização dos endpoints HTTP.
