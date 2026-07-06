#!/bin/bash
# Simulacao automatica e completa do fluxo TO-BE de emissao de NFS-e da VYX.
# Uso: npm run dev (num terminal) e depois `bash scripts/demo.sh` (noutro).
# Porta configuravel via BASE_URL, ex: BASE_URL=http://localhost:3001 bash scripts/demo.sh
set -e
BASE="${BASE_URL:-http://localhost:3000}"

section() { echo; echo "=========================================="; echo "$1"; echo "=========================================="; }
jpost() { curl -s -X POST "$BASE$1" -H "content-type: application/json" -d "$2"; }
jget() { curl -s "$BASE$1"; }
wait_status() {
  local id="$1" status="$2" tries=0
  while [ $tries -lt 50 ]; do
    current=$(jget "/invoices/$id" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    if [ "$current" = "$status" ]; then echo "  -> invoice $id chegou em '$status'"; return 0; fi
    sleep 0.1
    tries=$((tries+1))
  done
  echo "  -> TIMEOUT esperando invoice $id chegar em '$status' (ficou em '$current')"
}

section "1) Pagamento normal via Stripe (Ana Souza / Dr. Carlos Lima)"
RESP=$(jpost /webhooks/stripe '{"id":"evt_sim_1","type":"payment_intent.succeeded","data":{"object":{"id":"pi_sim_1","amount":25000,"currency":"brl","metadata":{"patient_id":"pat_1"}}}}')
echo "resposta imediata (ack rapido): $RESP"
ID1=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
wait_status "$ID1" issued

section "2) Pagamento via Pix (segundo gateway) - Bruno Alves / Dra. Fernanda Rocha"
RESP=$(jpost /webhooks/gateway2 '{"transactionId":"pix_sim_1","method":"pix","patientId":"pat_2","amountCents":18000,"paidAt":"2026-07-05T12:00:00Z"}')
echo "resposta imediata: $RESP"
ID2=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
wait_status "$ID2" issued

section "3) Prefeitura instavel: sobe taxa de falha para 70% e observa retry"
jpost /debug/nfse-failure-rate '{"rate":0.7}' > /dev/null
RESP=$(jpost /webhooks/stripe '{"id":"evt_sim_3","type":"payment_intent.succeeded","data":{"object":{"id":"pi_sim_3","amount":9000,"currency":"brl","metadata":{"patient_id":"pat_1"}}}}')
ID3=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
sleep 1.5
echo "estado apos retries: $(jget "/invoices/$ID3")"
jpost /debug/nfse-failure-rate '{"rate":0}' > /dev/null

section "4) Dado inconsistente: pagamento para paciente desconhecido"
RESP=$(jpost /webhooks/stripe '{"id":"evt_sim_4","type":"payment_intent.succeeded","data":{"object":{"id":"pi_sim_4","amount":5000,"currency":"brl","metadata":{"patient_id":"pat_desconhecido"}}}}')
echo "resposta: $RESP"

section "5) Crash-safety: simula nota travada em 'processing' e recupera"
STUCK=$(jpost /debug/simulate-stuck-invoice '{"patientId":"pat_1","stuckForMs":600000}')
echo "nota travada criada: $STUCK"
echo "resultado da recuperacao: $(jpost /debug/recover-stuck '{"olderThanMs":0}')"

section "6) Reconciliacao: pagamento aprovado no gateway cujo webhook nunca chegou"
MISSED=$(jpost /debug/simulate-missed-payment '{"patientId":"pat_2","amountCents":12000}')
echo "pagamento perdido registrado: $MISSED"
echo "resultado da reconciliacao: $(jpost /reconciliation/run '')"

section "7) Estorno: paciente e reembolsado, nota ja emitida deve ser cancelada"
RESP=$(jpost /webhooks/stripe '{"id":"evt_sim_7","type":"payment_intent.succeeded","data":{"object":{"id":"pi_sim_7","amount":30000,"currency":"brl","metadata":{"patient_id":"pat_1"}}}}')
ID7=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
wait_status "$ID7" issued
echo "resultado do estorno: $(jpost /webhooks/stripe '{"id":"evt_sim_7r","type":"charge.refunded","data":{"object":{"payment_intent":"pi_sim_7"}}}')"

section "8) Trilha de auditoria da nota do passo 1"
jget "/invoices/$ID1/audit"; echo

section "9) Estado final: todas as notas"
jget /invoices; echo

section "10) Alertas gerados durante a simulacao"
jget /alerts; echo

section "11) Metricas acumuladas"
jget /metrics; echo
