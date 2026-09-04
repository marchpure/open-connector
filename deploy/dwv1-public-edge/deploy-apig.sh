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

create_route() {
  name=$1
  path=$2
  priority=$3
  upstream=$4
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

create_route dwv1-mcp /mcp 100 "$runtime_upstream"
create_route dwv1-runtime-v1 /v1/ 90 "$runtime_upstream"
create_route dwv1-control-api /api/ 80 "$control_upstream"
create_route dwv1-console / 10 "$control_upstream"
