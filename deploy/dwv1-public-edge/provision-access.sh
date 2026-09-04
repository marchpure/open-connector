#!/bin/sh
set -eu

config=${1:?usage: provision-access.sh CONFIG_JSON}
secret_name=$(jq -r '.kms.secretName' "$config")
role_name=$(jq -r '.kms.roleName' "$config")
policy_name=$(jq -r '.kms.policyName' "$config")
vpc_id=$(jq -r '.network.vpcId' "$config")
instance_id=$(jq -r '.postgresql.instanceId' "$config")

security_group_id=$(jq -r '.network.securityGroupIds[0] // empty' "$config")
test -n "$security_group_id"

allow_list_id=$(ve rdspostgresql CreateAllowList \
  --AllowListName dwv1_openconnector_vefaas_dev \
  --AllowListCategory Ordinary \
  --AllowListType IPv4 \
  --AllowList 172.31.0.0/20 \
  --AllowListDesc "DWV1 VeFaaS dev subnet" \
  ---profile default | jq -r '.Result.AllowListId')
test -n "$allow_list_id"
ve rdspostgresql AssociateAllowList \
  --AllowListIds "[\"$allow_list_id\"]" \
  --InstanceIds "[\"$instance_id\"]" \
  ---profile default >/dev/null

secret_trn="trn:kms:cn-beijing:2107625663:secrets/$secret_name"
bucket=$(jq -r '.tos.bucket' "$config")
policy_document=$(jq -cn --arg trn "$secret_trn" --arg bucket "$bucket" \
  '{
    Statement:
      [{Effect:"Allow",Action:["kms:GetSecretValue"],Resource:[$trn]}] +
      (if $bucket == "" then [] else [{
        Effect:"Allow",
        Action:["tos:HeadObject","tos:GetObject","tos:PutObject","tos:ListBucket"],
        Resource:[
          ("trn:tos:::bucket/" + $bucket),
          ("trn:tos:::bucket/" + $bucket + "/transit/*")
        ]
      }] end)
  }')
trust_document='{"Statement":[{"Effect":"Allow","Action":["sts:AssumeRole"],"Principal":{"Service":["vefaas","vefaas_dev"]}}]}'

ve iam CreatePolicy \
  --PolicyName "$policy_name" \
  --PolicyDocument "$policy_document" \
  --Description "Read only the DWV1 OpenConnector dev Secret" \
  ---profile default >/dev/null
role_trn=$(ve iam CreateRole \
  --RoleName "$role_name" \
  --DisplayName "$role_name" \
  --Description "DWV1 OpenConnector VeFaaS dev role" \
  --TrustPolicyDocument "$trust_document" \
  --Tags.1.Key workload --Tags.1.Value dwv1-openconnector-dev \
  ---profile default | jq -r '.Result.Role.Trn // .Result.Trn')
ve iam AttachRolePolicy \
  --RoleName "$role_name" \
  --PolicyName "$policy_name" \
  --PolicyType Custom \
  ---profile default >/dev/null

jq -n \
  --arg securityGroupId "$security_group_id" \
  --arg allowListId "$allow_list_id" \
  --arg roleTrn "$role_trn" \
  --arg secretTrn "$secret_trn" \
  '{securityGroupId:$securityGroupId,allowListId:$allowListId,roleTrn:$roleTrn,secretTrn:$secretTrn}'
