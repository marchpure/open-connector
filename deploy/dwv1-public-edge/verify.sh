#!/bin/sh
set -eu

config=${1:?usage: verify.sh CONFIG_JSON RUNTIME_TOKEN_FILE}
runtime_token_file=${2:?usage: verify.sh CONFIG_JSON RUNTIME_TOKEN_FILE}
origin=$(jq -r '.apig.publicOrigin' "$config")
test "${origin#https://}" != "$origin"
test -s "$runtime_token_file"

evidence_dir=/tmp/data-workshop-v1-v3/w4-corrected
mkdir -p "$evidence_dir"
health_headers=$(mktemp)
mcp_headers=$(mktemp)
mcp_body=$(mktemp)
tools_body=$(mktemp)
tools_list_body=$(mktemp)
tools_call_body=$(mktemp)
trap 'rm -f "$health_headers" "$mcp_headers" "$mcp_body" "$tools_body" "$tools_list_body" "$tools_call_body"' EXIT

curl --fail --silent --show-error --max-time 20 \
  --dump-header "$health_headers" "$origin/health" >/dev/null
grep -Eiq '^cache-control:.*no-store' "$health_headers"

runtime_token=$(cat "$runtime_token_file")
status=$(curl --silent --show-error --no-buffer --max-time 60 \
  --output "$mcp_body" --dump-header "$mcp_headers" --write-out '%{http_code}' \
  -X POST "$origin/mcp" \
  -H "authorization: Bearer $runtime_token" \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"dwv1-w4","version":"3"}}}')
test "$status" = 200
grep -Eiq '^cache-control:.*no-store' "$mcp_headers"
grep -Eq '"result"|event: message' "$mcp_body"

curl --fail --silent --show-error --max-time 30 \
  -H "authorization: Bearer $runtime_token" \
  "$origin/mcp/tools" >"$tools_body"
jq -e '.tools | type == "array"' "$tools_body" >/dev/null

curl --fail --silent --show-error --no-buffer --max-time 60 \
  -H "authorization: Bearer $runtime_token" \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -X POST "$origin/mcp" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' >"$tools_list_body"
grep -Eq '"result"|event: message' "$tools_list_body"

curl --fail --silent --show-error --no-buffer --max-time 60 \
  -H "authorization: Bearer $runtime_token" \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -X POST "$origin/mcp" \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_apps","arguments":{}}}' >"$tools_call_body"
grep -Eq '"result"|event: message' "$tools_call_body"

unauthorized=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --max-time 20 -X POST "$origin/mcp" \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
test "$unauthorized" = 401

jq -n \
  --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg origin "$origin" \
  --arg sourceSha "$(jq -r '.sourceSha' "$config")" \
  --arg image "$(jq -r '.image' "$config")" \
  '{
    status: "passed",
    checkedAt: $checkedAt,
    publicOrigin: $origin,
    sourceSha: $sourceSha,
    image: $image,
    httpsHealth: true,
    noStore: true,
    runtimeApiKeyInitialize: true,
    runtimeApiKeyToolsList: true,
    standardMcpToolsList: true,
    safeReadOnlyToolsCall: "list_apps",
    unauthenticatedRejected: true,
    secretsRecorded: false
  }' >"$evidence_dir/mcp-smoke.json"
