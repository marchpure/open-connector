# DWV1 W4 corrected VeFaaS public edge

This directory owns only the dev VeFaaS, KMS, PostgreSQL, TOS, and APIG deployment of
OpenConnector. It does not create or operate ECS, EIP, Caddy, local PostgreSQL,
MinIO, AgentKit MCP Gateway, or product UI resources.

W4.1 starts from immutable W4 deployment commit
`a2d798a1d34a17c97f40aa3365bab2fa62e1f000` and source commit
`20b966a0bdcbbcef55d8cba33ef5c380b2502efe`. Its release image is built
from the final W4.1 Git commit with `Dockerfile.w41`, then pinned by digest.

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

The frozen dev origin is:

```text
https://su4f9ugsggenk65g7f7m5.apigateway-cn-beijing.volceapi.com
```

The VeFaaS bootstrap image is pinned by registry digest:

```text
idv-order-discount-agent-test-cn-beijing.cr.volces.com/idv-order-discount-agent-test/knowledge-dev-connection-service@sha256:18aa05b29b2374ec721500c82611f83373118e4b4668b8a34688324383f689bf
```

Transit files use the private `dwv1-openconnector-dev-2107625663` TOS bucket.
Only the function role can access its `transit/` prefix, which expires objects
after two days and incomplete multipart uploads after one day.

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

## WorkBuddy OAuth bridge

W4.1 enables the bridge only after a dedicated UserPool and confidential web
client exist. The browser-facing WorkBuddy configuration contains only the
public `/mcp` URL. The client secret is supplied to `provision-sensitive.mjs`
through the `OPENCONNECTOR_OAUTH_CLIENT_SECRET` process environment and is
written only to the existing KMS Secret; it must not be placed in the config
file, Git, logs, evidence, or WorkBuddy.

`identity.allowedRedirectUris` is a comma-separated exact allowlist obtained
from WorkBuddy's first authorization request. Wildcard `workbuddy:` redirects
are rejected. Both functions receive the same KMS-backed OAuth metadata, while
only the control-plane role serves `/.well-known/*` and `/oauth/*`.

## Release

After PostgreSQL reuse and the cloud write set are approved:

1. Run `preflight.sh`.
2. Build and push the W4.1 application plus KMS bootstrap image from repository
   root:

   `docker build -f deploy/dwv1-public-edge/Dockerfile.w41 -t <image> .`

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
