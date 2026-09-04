#!/bin/sh
set -eu

receipt=${1:?usage: rollback.sh RELEASE_RECEIPT_JSON}

for role in controlPlane mcpRuntime; do
  function_id=$(jq -r ".$role.functionId" "$receipt")
  revision=$(jq -r ".$role.previousRevision" "$receipt")
  test -n "$function_id" && test "$revision" -gt 0
  ve vefaas Release \
    --FunctionId "$function_id" \
    --RevisionNumber "$revision" \
    --MinInstance 1 \
    --RollingStep 25 \
    --TargetTrafficWeight 100 \
    --Description "DWV1 rollback" \
    ---profile default
done
