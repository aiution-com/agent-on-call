#!/usr/bin/env bash
set -euo pipefail

API="${API:-http://127.0.0.1:3000}"
ORG_ID="${ORG_ID:-00000000-0000-0000-0000-000000000001}"

id() {
  python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])'
}

echo "Using API: $API"

AGENT_JSON=$(curl -sS -X POST "$API/api/v1/agents" \
  -H 'Content-Type: application/json' \
  -d "{\"orgId\":\"$ORG_ID\",\"name\":\"demo-agent-$(date +%s)\",\"type\":\"coding\",\"ownerEmail\":\"shivam@agentoncall.dev\",\"capabilities\":{\"skills\":[\"demo\"]}}")
AGENT_ID=$(echo "$AGENT_JSON" | id)

TASK_JSON=$(curl -sS -X POST "$API/api/v1/tasks" \
  -H 'Content-Type: application/json' \
  -d "{\"orgId\":\"$ORG_ID\",\"title\":\"Demo: propose README summary\",\"description\":\"Read README.md and propose a 3-line summary. Do not commit.\",\"source\":\"api\",\"budgetUsd\":0.10,\"permissions\":{\"commit\":false},\"requiredApprovals\":[\"commit\"],\"timeoutSeconds\":600}")
TASK_ID=$(echo "$TASK_JSON" | id)

curl -sS -X POST "$API/api/v1/tasks/$TASK_ID/claim" \
  -H 'Content-Type: application/json' \
  -d "{\"agentId\":\"$AGENT_ID\"}" > /dev/null

curl -sS -X PATCH "$API/api/v1/tasks/$TASK_ID/status" \
  -H 'Content-Type: application/json' \
  -d '{"status":"in_progress"}' > /dev/null

curl -sS -X POST "$API/api/v1/tasks/$TASK_ID/spend" \
  -H 'Content-Type: application/json' \
  -d '{"amountUsd":0.01}' > /dev/null

APPROVAL_JSON=$(curl -sS -X POST "$API/api/v1/approvals" \
  -H 'Content-Type: application/json' \
  -d "{\"taskId\":\"$TASK_ID\",\"agentId\":\"$AGENT_ID\",\"type\":\"commit\",\"amountUsd\":null,\"context\":{\"files\":[\"README.md\"],\"summary\":\"Proposed README summary\"},\"approverChain\":[\"shivam@agentoncall.dev\"]}")
APPROVAL_ID=$(echo "$APPROVAL_JSON" | id)

curl -sS -X POST "$API/api/v1/approvals/$APPROVAL_ID/decide" \
  -H 'Content-Type: application/json' \
  -d '{"decision":"approved","decidedBy":"demo-human","reason":"Approved from demo"}' > /dev/null

curl -sS -X PATCH "$API/api/v1/tasks/$TASK_ID/status" \
  -H 'Content-Type: application/json' \
  -d '{"status":"done"}' > /dev/null

echo "AGENT_ID=$AGENT_ID"
echo "TASK_ID=$TASK_ID"
echo "APPROVAL_ID=$APPROVAL_ID"

echo
echo "Agent:"
curl -sS "$API/api/v1/agents/$AGENT_ID" | python3 -m json.tool

echo
echo "Task:"
curl -sS "$API/api/v1/tasks/$TASK_ID" | python3 -m json.tool
