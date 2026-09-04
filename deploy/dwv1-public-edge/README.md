# DWV1 W4 corrected VeFaaS public edge

This directory owns only the dev VeFaaS, KMS, PostgreSQL, TOS, and APIG deployment of
OpenConnector. It does not create or operate ECS, EIP, Caddy, local PostgreSQL,
MinIO, AgentKit MCP Gateway, or product UI resources.

The immutable source is
`20b966a0bdcbbcef55d8cba33ef5c380b2502efe`. The immutable image is:

```text
idv-order-discount-agent-test-cn-beijing.cr.volces.com/idv-order-discount-agent-test/knowledge-dev-connection-service@sha256:d853446c637643990677feb7bbe21b24acd78e9a21446cc00a75e201ed942583
```

## Architecture

- KMS stores the approved PostgreSQL URL, Admin Token, Runtime Token,
  encryption key, and optional TOS credentials in one dedicated Secret.
- A dedicated VeFaaS IAM role can read only that Secret.
- `dwv1-openconnector-control-plane-dev` runs
  `/usr/local/bin/open-connector control-plane`.
- `dwv1-openconnector-mcp-runtime-dev` runs
  `/usr/local/bin/open-connector mcp-runtime`.
- Both are `native/v1` VeFaaS web functions. The bootstrap listens on port
  8080 and proxies to OpenConnector on loopback port 3000. They share cloud
  PostgreSQL state, use TOS for objects, and have no local durable state.
- APIG routes `/mcp` and `/v1/*` to the runtime function, and `/api/*` plus the
  console to the control-plane function.

The protected customer host `101.126.155.97` is explicitly outside this
deployment and rollback boundary.

## Gates

Copy `config.example.json` outside the repository and fill only approved
resource identifiers. Do not put secret values in the file. `preflight.sh`
rejects unapproved PostgreSQL reuse, missing VPC settings, a mutable image
reference, the wrong source SHA, or partial Identity configuration.

VeFaaS injects the bound role's temporary credentials into Web requests as
`x-faas-*` headers. The thin bootstrap proxy reads the dedicated KMS Secret
with those credentials, exports an allow-listed set of values only in the
OpenConnector child process, strips the platform credential headers, and
forwards the request. Plaintext secret values in function `Envs` are prohibited.

Identity is optional for the first corrected deployment. If issuer, audience,
JWKS URI, UserPool, and Client are not all approved and available, deploy and
verify the Runtime API Key path, then report Identity/WorkBuddy as the sole
external blocker.

## Release

After PostgreSQL reuse and the cloud write set are approved:

1. Run `preflight.sh`.
2. Build and push the thin bootstrap image derived from the corrected digest.
3. Create the dedicated KMS Secret, IAM policy/role, database/account and
   VeFaaS network security group.
4. Run `deploy-vefaas.sh` to create/update and release with `MinInstance=1`.
5. Create a dedicated HTTPS APIG service and two VeFaaS upstreams. Record their
   IDs, run `create-apig-upstreams.sh` when only upstreams are missing, then run
   `deploy-apig.sh` to create the four path routes.
6. Run `verify.sh` with a mode-0600 Runtime API Key file.

All Volcengine calls use `---profile default`. VeFaaS releases use rolling
traffic. `rollback.sh` releases the previous recorded revisions. Evidence
belongs under `/tmp/data-workshop-v1-v3/w4-corrected/` and must never contain
credentials.
