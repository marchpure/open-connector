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

  common_body=$(jq -n \
    --arg command "$command" \
    --arg source "$image" \
    --arg drc_binding "$(jq -r '.drc.bindingId' "$config")" \
    --arg postgres_resource "$(jq -r '.drc.postgresResourceId' "$config")" \
    --arg tos_resource "$(jq -r '.drc.tosResourceId' "$config")" \
    --arg secret_resource "$(jq -r '.drc.secretResourceId' "$config")" \
    --arg source_sha "$(jq -r '.sourceSha' "$config")" \
    --argjson port "$(jq '.runtime.port' "$config")" \
    --argjson timeout "$(jq '.runtime.requestTimeout' "$config")" \
    --argjson cpu "$(jq '.runtime.cpuMilli' "$config")" \
    --argjson memory "$(jq '.runtime.memoryMB' "$config")" \
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
      CpuStrategy: "always",
      ExclusiveMode: false,
      MaxConcurrency: 100,
      ProjectName: "default",
      Envs: [
        {Key: "HOST", Value: "0.0.0.0"},
        {Key: "PORT", Value: ($port | tostring)},
        {Key: "NODE_ENV", Value: "production"},
        {Key: "DWV1_SOURCE_SHA", Value: $source_sha},
        {Key: "DWV1_DRC_BINDING_ID", Value: $drc_binding},
        {Key: "DWV1_POSTGRES_RESOURCE_ID", Value: $postgres_resource},
        {Key: "DWV1_TOS_RESOURCE_ID", Value: $tos_resource},
        {Key: "DWV1_SECRET_RESOURCE_ID", Value: $secret_resource}
      ],
      TosMountConfig: {EnableTos: false},
      NasStorage: {EnableNas: false}
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
    printf 'Bind approved DRC secrets to function %s before release.\n' "$function_id" >&2
    continue
  fi

  ve vefaas Release \
    --FunctionId "$function_id" \
    --RevisionNumber 0 \
    --MinInstance "$(jq -r '.runtime.minInstance' "$config")" \
    --MaxInstance "$(jq -r '.runtime.maxInstance' "$config")" \
    --RollingStep 25 \
    --TargetTrafficWeight 100 \
    --Description "DWV1 corrected 20b966a0bdcbbcef" \
    ---profile default
done
