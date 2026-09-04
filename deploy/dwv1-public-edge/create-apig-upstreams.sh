#!/bin/sh
set -eu

config=${1:?usage: create-apig-upstreams.sh CONFIG_JSON}
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$root/preflight.sh" "$config"

gateway_id=$(jq -r '.apig.gatewayId' "$config")
control_id=$(jq -r '.controlPlane.functionId' "$config")
runtime_id=$(jq -r '.mcpRuntime.functionId' "$config")
test -n "$gateway_id" && test -n "$control_id" && test -n "$runtime_id"

create_upstream() {
  name=$1
  function_id=$2
  ve apig CreateUpstream \
    --GatewayId "$gateway_id" \
    --Name "$name" \
    --Protocol HTTP \
    --SourceType VeFaas \
    --ConnectionPoolSettings.Enable true \
    --ConnectionPoolSettings.MaxConnections 1024 \
    --ConnectionPoolSettings.Http1MaxPendingRequests 1024 \
    --ConnectionPoolSettings.IdleTimeout 900 \
    --LoadBalancerSettings.LbPolicy SimpleLB \
    --LoadBalancerSettings.SimpleLB ROUND_ROBIN \
    --UpstreamSpec.VeFaas.FunctionId "$function_id" \
    ---profile default
}

create_upstream dwv1-control-plane-dev "$control_id"
create_upstream dwv1-mcp-runtime-dev "$runtime_id"
