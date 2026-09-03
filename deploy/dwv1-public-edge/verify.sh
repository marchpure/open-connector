#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
env_file=${1:-/etc/dwv1-w4.env}
evidence_dir=/tmp/data-workshop-v1-v3/w4
evidence=$evidence_dir/latest.json

set -a
. "$env_file"
set +a

mkdir -p "$evidence_dir"
health_headers=$(mktemp)
mcp_headers=$(mktemp)
contract_headers=$(mktemp)
contract_body=$(mktemp)
evidence_headers=$(mktemp)
trap 'rm -f "$health_headers" "$mcp_headers" "$contract_headers" "$contract_body" "$evidence_headers"' EXIT

health_body=$(curl --fail --silent --show-error --max-time 15 \
  --dump-header "$health_headers" "$PUBLIC_ORIGIN/health")
printf '%s' "$health_body" | grep -q '"ok":true'
grep -Eiq '^cache-control:.*no-store' "$health_headers"

mcp_status=$(curl --silent --show-error --max-time 15 \
  --output /dev/null --write-out '%{http_code}' --dump-header "$mcp_headers" \
  -X POST "$PUBLIC_ORIGIN/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"dwv1-w4-probe","version":"1"}}}')
test "$mcp_status" = 401
grep -Eiq '^cache-control:.*no-store' "$mcp_headers"

probe_token="synthetic-contract-probe"
curl --fail --silent --show-error --no-buffer --max-time 15 \
  --dump-header "$contract_headers" --output "$contract_body" \
  -X POST "$PUBLIC_ORIGIN/edge-contract/mcp" \
  -H "authorization: Bearer $probe_token" \
  -H 'mcp-session-id: synthetic-session' \
  -H 'last-event-id: synthetic-event' \
  -H 'accept: text/event-stream' \
  -H 'content-type: application/json' \
  --data '{}'

grep -Eiq '^content-type: text/event-stream' "$contract_headers"
grep -Eiq '^cache-control:.*no-store' "$contract_headers"
grep -q '"authorizationPresent":true' "$contract_body"
grep -q '"authorizationScheme":"Bearer"' "$contract_body"
grep -q '"mcpSessionIdPresent":true' "$contract_body"
grep -q '"lastEventIdPresent":true' "$contract_body"
test "$(grep -c '^data:' "$contract_body")" -eq 2

evidence_status=$(curl --fail --silent --show-error --max-time 15 \
  --dump-header "$evidence_headers" "$PUBLIC_ORIGIN/edge-contract/evidence")
grep -Eiq '^cache-control:.*no-store' "$evidence_headers"
printf '%s' "$evidence_status" | grep -q '"status":"BLOCKED_UPSTREAM"'
printf '%s' "$evidence_status" | grep -q '"authorizationValueRecorded":false'

cat >"$evidence.tmp" <<EOF
{
  "status": "BLOCKED_UPSTREAM",
  "checkedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "publicOrigin": "$PUBLIC_ORIGIN",
  "sourceSha": "$SOURCE_SHA",
  "image": "$OPEN_CONNECTOR_IMAGE",
  "healthHttps": true,
  "healthNoStore": true,
  "browserEvidenceUrl": "$PUBLIC_ORIGIN/edge-contract/evidence",
  "realMcpProtected": true,
  "contractOnly": {
    "authorizationHeaderForwarded": true,
    "authorizationScheme": "Bearer",
    "mcpSessionHeaderForwarded": true,
    "lastEventIdForwarded": true,
    "streamContentType": "text/event-stream",
    "streamChunkCount": 2,
    "noStore": true
  },
  "secretsRecorded": false,
  "blocker": "W1 enhanced runtime and W2 approved WorkBuddy UserPool/Client are not merged beyond the frozen base"
}
EOF
chmod 0644 "$evidence.tmp"
mv "$evidence.tmp" "$evidence"
printf '%s\n' "$evidence"
