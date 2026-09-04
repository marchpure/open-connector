#!/bin/sh
set -eu

config=${1:?usage: deploy-vefaas.sh CONFIG_JSON}
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$root/preflight.sh" "$config"

image=$(jq -r '.image' "$config")
for role in controlPlane mcpRuntime; do
  name=$(jq -r ".$role.name" "$config")
  function_id=$(jq -r ".$role.functionId" "$config")
  command=$(jq -r ".$role.command" "$config")
  openconnector_role=$(jq -r ".$role.role" "$config")

  common_body=$(jq -n \
    --arg command "$command" \
    --arg source "$image" \
    --arg secret_name "$(jq -r '.kms.secretName' "$config")" \
    --arg role_trn "$(jq -r '.kms.roleTrn' "$config")" \
    --arg openconnector_role "$openconnector_role" \
    --arg source_sha "$(jq -r '.sourceSha' "$config")" \
    --arg public_origin "$(jq -r '.apig.publicOrigin' "$config")" \
    --argjson port "$(jq '.runtime.port' "$config")" \
    --argjson timeout "$(jq '.runtime.requestTimeout' "$config")" \
    --argjson cpu "$(jq '.runtime.cpuMilli' "$config")" \
    --argjson memory "$(jq '.runtime.memoryMB' "$config")" \
    --arg vpc_id "$(jq -r '.network.vpcId' "$config")" \
    --argjson subnet_ids "$(jq '.network.subnetIds' "$config")" \
    --argjson security_group_ids "$(jq '.network.securityGroupIds' "$config")" \
    '{
      Command: $command,
      Source: $source,
      SourceType: "image",
      Runtime: "native/v1",
      Port: $port,
      RequestTimeout: $timeout,
      InitializerSec: 120,
      CpuMilli: $cpu,
      MemoryMB: $memory,
      ExclusiveMode: false,
      MaxConcurrency: 100,
      ProjectName: "default",
      Role: $role_trn,
      Envs: [
        {Key: "HOST", Value: "0.0.0.0"},
        {Key: "PORT", Value: ($port | tostring)},
        {Key: "NODE_ENV", Value: "production"},
        {Key: "DWV1_SOURCE_SHA", Value: $source_sha},
        {Key: "DWV1_KMS_SECRET_NAME", Value: $secret_name},
        {Key: "DWV1_OPENCONNECTOR_ROLE", Value: $openconnector_role},
        {Key: "DWV1_INTERNAL_PORT", Value: "3000"}
        ,{Key: "OOMOL_CONNECT_ORIGIN", Value: $public_origin}
      ],
      TosMountConfig: {EnableTos: false},
      NasStorage: {EnableNas: false},
      VpcConfig: {
        EnableVpc: true,
        EnableSharedInternetAccess: true,
        VpcId: $vpc_id,
        SubnetIds: $subnet_ids,
        SecurityGroupIds: $security_group_ids
      }
    }')

  if test -n "$function_id"; then
    body=$(printf '%s' "$common_body" | jq --arg id "$function_id" '. + {Id: $id}')
    ve vefaas UpdateFunction --body "$body" ---profile default >/dev/null
  else
    body=$(printf '%s' "$common_body" | jq --arg name "$name" '. + {Name: $name}')
    function_id=$(ve vefaas CreateFunction --body "$body" ---profile default |
      jq -r '.Result.Id // .Result.FunctionId')
    test -n "$function_id"
    printf '%s=%s\n' "$role" "$function_id"
  fi

  ve vefaas Release \
    --FunctionId "$function_id" \
    --RevisionNumber 0 \
    --MinInstance "$(jq -r '.runtime.minInstance' "$config")" \
    --MaxInstance "$(jq -r '.runtime.maxInstance' "$config")" \
    --RollingStep 25 \
    --TargetTrafficWeight 100 \
    --Description "DWV1 W4.1 $(jq -r '.sourceSha' "$config" | cut -c1-16)" \
    ---profile default
done
