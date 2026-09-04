# DWV1 W4 minimum cloud write set

All commands use `---profile default`. Secret values and the database password
must be generated and submitted through a protected input path; they must not
be substituted into shell command arguments.

## Reusable resources

- RDS PostgreSQL instance: `postgres-ef669f38f7c6`
- Private endpoint: `postgresef669f38f7c6.rds-pg.ivolces.com:5432`
- VPC: `vpc-mjim3l8hsem85smt1a0iylbv`
- Subnet: `subnet-13g72tjkk4lj43n6nu5iogni4`
- CR repository:
  `idv-order-discount-agent-test-cn-beijing.cr.volces.com/idv-order-discount-agent-test/knowledge-dev-connection-service`

The RDS instance is Running and currently reports zero accounts, zero
databases, and zero allowlists. Reuse still requires explicit approval.

## Required new resources

- Database `open_connector_dev`
- Normal account `open_connector_app` with `Login,Inherit`
- Dedicated VeFaaS VPC security group
- KMS Generic Secret `dwv1/openconnector/dev`
- IAM policy `DWV1OpenConnectorSecretRead`
- IAM role `DWV1OpenConnectorVeFaaSDevRole`
- Bootstrap image derived from the corrected registry digest
- Two native/v1 VeFaaS functions
- Dedicated APIG gateway, HTTPS service, two VeFaaS upstreams, and four routes

## Core commands

```sh
ve vpc CreateSecurityGroup \
  --VpcId vpc-mjim3l8hsem85smt1a0iylbv \
  --SecurityGroupName dwv1-openconnector-vefaas-dev \
  --Description "DWV1 OpenConnector VeFaaS dev egress" \
  --ProjectName default \
  --Tags.1.Key workload --Tags.1.Value dwv1-openconnector-dev \
  ---profile default

ve rdspostgresql CreateAllowList \
  --AllowListName dwv1_openconnector_vefaas_dev \
  --AllowListCategory Ordinary \
  --AllowListType IPv4 \
  --AllowList 172.31.0.0/20 \
  --AllowListDesc "DWV1 VeFaaS dev subnet" \
  ---profile default

ve rdspostgresql AssociateAllowList \
  --AllowListIds '["<new-allowlist-id>"]' \
  --InstanceIds '["postgres-ef669f38f7c6"]' \
  ---profile default

# Generates the database password and OpenConnector tokens in memory, calls
# CreateDBAccount, CreateDatabase and CreateSecret, and prints only request IDs.
VOLCENGINE_PROFILE=default node bootstrap/provision-sensitive.mjs \
  /secure/path/w4.json

ve iam CreatePolicy \
  --PolicyName DWV1OpenConnectorSecretRead \
  --PolicyDocument \
  '{"Statement":[{"Effect":"Allow","Action":["kms:GetSecretValue"],"Resource":["trn:kms:cn-beijing:2107625663:secrets/dwv1/openconnector/dev"]}]}' \
  --Description "Read only the DWV1 OpenConnector dev Secret" \
  ---profile default

ve iam CreateRole \
  --RoleName DWV1OpenConnectorVeFaaSDevRole \
  --DisplayName DWV1OpenConnectorVeFaaSDevRole \
  --Description "DWV1 OpenConnector VeFaaS dev role" \
  --TrustPolicyDocument \
  '{"Statement":[{"Effect":"Allow","Action":["sts:AssumeRole"],"Principal":{"Service":["vefaas","vefaas_dev"]}}]}' \
  ---profile default

ve iam AttachRolePolicy \
  --RoleName DWV1OpenConnectorVeFaaSDevRole \
  --PolicyName DWV1OpenConnectorSecretRead \
  --PolicyType Custom \
  ---profile default
```

The bootstrap image is built from `Dockerfile.bootstrap`, pushed with tag
`corrected-20b966a0bdcbbcef-kms-bootstrap`, resolved back to a registry digest,
then written to the external deployment config. `deploy-vefaas.sh`,
`create-apig-upstreams.sh`, and `deploy-apig.sh` perform the remaining
VeFaaS/APIG writes after their IDs become available.

The dedicated APIG gateway uses `small_1`, `1c2g`, two replicas, traffic-billed
public networking, VPC `vpc-mjim3l8hsem85smt1a0iylbv`, and subnet
`subnet-13g72tjkk4lj43n6nu5iogni4`. It does not update gateway
`gd9ljae5b1nffgnhcvma0` or any customer service, route, or upstream.

The exact remaining actions are:

- `ve vefaas CreateFunction`, `ve vefaas Release`,
  `ve vefaas GetFunction`, `ve vefaas GetReleaseStatus`
- `ve apig CreateGateway`, `ve apig CreateGatewayService`,
  `ve apig CreateUpstream`, `ve apig GetGatewayService`,
  `ve apig GetUpstream`
- `ve apig20221112 CreateRoute`, `ve apig20221112 GetRoute`

## Optional TOS completion

Resource Center reports no TOS buckets in `cn-beijing`. The proposed bucket is
private, Standard storage, globally unique name
`dwv1-openconnector-dev-2107625663`, with objects under `transit/` expiring
after two days and incomplete multipart uploads aborted after one day.

```sh
node tools/provision-tos.mjs dwv1-openconnector-dev-2107625663
```

TOS storage and requests are usage billed. Omitting this step permits the core
health/MCP smoke only and does not qualify as full W4 completion.
