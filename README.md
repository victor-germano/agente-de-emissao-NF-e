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

## Além do documento: fechando lacunas de uma automação completa

O documento original cobre o caminho feliz e lista pontos em aberto, mas
"financeiro sai completamente da operação manual" só é verdade se falhas
forem visíveis e o sistema se recuperar sozinho de problemas comuns. Cinco
adições cobrem isso:

1. **Alertas ativos em falha** (`AlertNotifier`, `src/adapters/alerting`) —
   toda falha de emissão, dado inconsistente, estorno de pagamento
   desconhecido ou achado da reconciliação dispara um alerta, hoje guardado
   em memória e exposto via `GET /alerts` (consumido pelo painel visual). Em
   produção, troca-se `InMemoryAlertNotifier` por uma implementação que
   posta num webhook do Slack/PagerDuty — mesma interface.
2. **Recuperação de notas travadas** (`InvoiceEmissionService.recoverStuckInvoices`)
   — varre invoices presas em `"processing"` (ex: o processo caiu no meio da
   emissão) e tenta finalizá-las. Roda a cada `RECOVERY_SWEEP_INTERVAL_MS` e
   também sob demanda via `POST /debug/recover-stuck`.
3. **Verificação de assinatura do webhook Stripe** (`src/adapters/paymentGateway/stripeSignature.ts`)
   — reimplementa o esquema real do Stripe (`t=<timestamp>,v1=<hmac>`), não
   um placeholder. Ativa automaticamente quando `STRIPE_WEBHOOK_SECRET` é
   configurada; sem ela, a checagem é pulada (conveniente para o painel
   local). O segundo gateway tem uma checagem equivalente mais simples via
   header `x-gateway2-secret` + `GATEWAY2_WEBHOOK_SECRET`.
4. **Reconciliação Stripe × notas emitidas** (`ReconciliationService`) — roda
   periodicamente (`RECONCILIATION_INTERVAL_MS`) comparando os pagamentos
   aprovados no gateway com as invoices existentes, para pegar casos em que
   o webhook nunca chegou. Também disparável via `POST /reconciliation/run`.
5. **Cancelamento por estorno** — um evento `charge.refunded` do Stripe
   localiza a invoice pelo `payment_intent` original, cancela a NFS-e já
   emitida (`NFSeClient.cancel`) e avisa o paciente por e-mail. Sem isso, um
   reembolso deixaria uma nota fiscal órfã no sistema.

## Rodando localmente

```bash
npm install
cp .env.example .env
npm run dev        # http://localhost:3000
```

### Painel visual

Abrindo `http://localhost:3000` no navegador (servido pelo próprio Express a
partir de `public/index.html`, sem build/framework) você tem: formulário
para simular pagamentos (Stripe ou segundo gateway); controle para forçar a
taxa de falha do mock da Prefeitura; simulação de nota travada + botão de
recuperação; simulação de pagamento perdido + botão de reconciliação;
simulação de estorno sobre uma nota já emitida; feed de alertas recentes; e
a tabela de notas processadas — tudo atualizado a cada 2s. Os dados são
in-memory: reiniciar o servidor limpa tudo.

Simular um pagamento Stripe via curl (alternativa ao painel):

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

Consultar: `GET /invoices`, `GET /invoices/:id`, `GET /invoices/failed`,
`GET /alerts`.

Outros endpoints de debug/operação: `POST /debug/simulate-stuck-invoice`,
`POST /debug/recover-stuck`, `POST /debug/simulate-missed-payment`,
`POST /reconciliation/run`.

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
tentativas, dados inconsistentes, os dois webhooks HTTP fim a fim,
recuperação de notas travadas, estorno/cancelamento, reconciliação e
verificação de assinatura do Stripe (assinatura válida, adulterada, segredo
errado, timestamp expirado).

## Como plugar as integrações reais

- **Supabase**: implementar `PatientDoctorRepository` e `InvoiceRepository`
  usando `@supabase/supabase-js` (tabelas `patients`, `doctors`,
  `consultations`, `invoices`), reaproveitando as variáveis já previstas em
  `.env.example` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), e trocar a
  instância em `src/index.ts`.
- **Stripe real**: a verificação de assinatura já está implementada
  (`verifyStripeSignature`) — basta configurar `STRIPE_WEBHOOK_SECRET` com o
  segredo real do endpoint.
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
  processo limpa os dados (inclusive os "presos em processing" simulados
  para o debug).
- Autenticação/autorização dos endpoints de consulta e debug (`/invoices`,
  `/alerts`, `/debug/*`) — só os webhooks de pagamento têm verificação de
  origem (assinatura Stripe / segredo compartilhado).
- Reconciliação real com a API do Stripe — `ReconciliationGateway` é mockado
  (lista o que foi injetado via `/debug/simulate-missed-payment`); em
  produção, implementaria `listRecentSuccessfulPayments` consultando
  `stripe.charges.list` ou similar.
