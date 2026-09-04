#!/bin/sh
set -eu

config=${1:?usage: create-apig.sh CONFIG_JSON}
vpc_id=$(jq -r '.network.vpcId' "$config")
subnets=$(jq -c '.network.subnetIds' "$config")

gateway_id=$(ve apig CreateGateway \
  --Name dwv1-openconnector-dev-gateway \
  --Region cn-beijing \
  --Type standard \
  --ProjectName default \
  --NetworkSpec.VpcId "$vpc_id" \
  --NetworkSpec.SubnetIds "$subnets" \
  --ResourceSpec.CLBSpecCode small_1 \
  --ResourceSpec.InstanceSpecCode 1c2g \
  --ResourceSpec.NetworkType.EnablePrivateNetwork true \
  --ResourceSpec.NetworkType.EnablePublicNetwork true \
  --ResourceSpec.PublicNetworkBandwidth 0 \
  --ResourceSpec.PublicNetworkBillingType traffic \
  --ResourceSpec.Replicas 2 \
  --LogSpec.Enable false \
  --MonitorSpec.Enable false \
  --Comments "DWV1 OpenConnector corrected dev" \
  ---profile default | jq -r '.Result.Id // .Result.GatewayId')
test -n "$gateway_id"

service_id=$(ve apig CreateGatewayService \
  --GatewayId "$gateway_id" \
  --ServiceName dwv1-openconnector-dev \
  --Protocol '["HTTPS"]' \
  --DomainType DefaultDomain \
  --AuthSpec.Enable false \
  --ServiceNetworkSpec.EnablePublicNetwork true \
  --ServiceNetworkSpec.EnablePrivateNetwork false \
  --Comments "DWV1 OpenConnector corrected dev" \
  ---profile default | jq -r '.Result.Id // .Result.ServiceId')
test -n "$service_id"
jq -n --arg gatewayId "$gateway_id" --arg serviceId "$service_id" \
  '{gatewayId:$gatewayId,serviceId:$serviceId}'
