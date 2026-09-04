#!/bin/sh
set -eu

config=${1:?usage: deploy-apig.sh CONFIG_JSON}
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$root/preflight.sh" "$config"

gateway_id=$(jq -r '.apig.gatewayId' "$config")
service_id=$(jq -r '.apig.serviceId' "$config")
control_upstream=$(jq -r '.apig.controlPlaneUpstreamId' "$config")
runtime_upstream=$(jq -r '.apig.mcpRuntimeUpstreamId' "$config")
test -n "$gateway_id"
test -n "$service_id" || {
  printf 'APIG service ID is missing; create the dedicated HTTPS dev service first.\n' >&2
  exit 1
}
test -n "$control_upstream" && test -n "$runtime_upstream" || {
  printf 'APIG upstream IDs are missing; create VeFaaS upstreams first.\n' >&2
  exit 1
}

upsert_route() {
  name=$1
  path=$2
  priority=$3
  upstream=$4
  route_id=$(ve apig20221112 ListRoutes \
    --GatewayId "$gateway_id" \
    --ServiceId "$service_id" \
    --PageNumber 1 \
    --PageSize 100 \
    ---profile default |
    jq -r --arg name "$name" '.Result.Items[]? | select(.Name == $name) | .Id' |
    head -n 1)
  if test -n "$route_id"; then
    ve apig20221112 UpdateRoute \
      --Id "$route_id" \
      --Name "$name" \
      --Enable true \
      --Priority "$priority" \
      --MatchRule.Path.MatchType Prefix \
      --MatchRule.Path.MatchContent "$path" \
      --MatchRule.Method '["GET","POST","PUT","DELETE","HEAD","OPTIONS","PATCH"]' \
      --AdvancedSetting.TimeoutSetting.Enable true \
      --AdvancedSetting.TimeoutSetting.Timeout 900 \
      --AdvancedSetting.RetryPolicySetting.Enable false \
      --UpstreamList.1.UpstreamId "$upstream" \
      --UpstreamList.1.Weight 100 \
      ---profile default
    return
  fi
  ve apig20221112 CreateRoute \
    --Name "$name" \
    --ServiceId "$service_id" \
    --Enable true \
    --Priority "$priority" \
    --MatchRule.Path.MatchType Prefix \
    --MatchRule.Path.MatchContent "$path" \
    --MatchRule.Method '["GET","POST","PUT","DELETE","HEAD","OPTIONS","PATCH"]' \
    --AdvancedSetting.TimeoutSetting.Enable true \
    --AdvancedSetting.TimeoutSetting.Timeout 900 \
    --AdvancedSetting.RetryPolicySetting.Enable false \
    --UpstreamList.1.UpstreamId "$upstream" \
    --UpstreamList.1.Weight 100 \
    ---profile default
}

upsert_route dwv1-mcp /mcp 10 "$runtime_upstream"
upsert_route dwv1-oauth-metadata /.well-known/ 20 "$control_upstream"
upsert_route dwv1-oauth-bridge /oauth/ 30 "$control_upstream"
upsert_route dwv1-runtime-v1 /v1/ 40 "$runtime_upstream"
upsert_route dwv1-control-api /api/ 50 "$control_upstream"
upsert_route dwv1-console / 100 "$control_upstream"
