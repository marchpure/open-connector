# DWV1 W4 corrected VeFaaS public edge

This directory owns only the dev DRC, VeFaaS, and APIG deployment of
OpenConnector. It does not create or operate ECS, EIP, Caddy, local PostgreSQL,
MinIO, AgentKit MCP Gateway, or product UI resources.

The immutable source is
`20b966a0bdcbbcef55d8cba33ef5c380b2502efe`. The immutable image is:

```text
idv-order-discount-agent-test-cn-beijing.cr.volces.com/idv-order-discount-agent-test/knowledge-dev-connection-service@sha256:d853446c637643990677feb7bbe21b24acd78e9a21446cc00a75e201ed942583
```

## Architecture

- DRC supplies approved PostgreSQL, TOS, and secret bindings.
- `dwv1-openconnector-control-plane-dev` runs
  `/usr/local/bin/open-connector control-plane`.
- `dwv1-openconnector-mcp-runtime-dev` runs
  `/usr/local/bin/open-connector mcp-runtime`.
- Both are `native/v1` VeFaaS web functions, listen on port 3000, share cloud
  PostgreSQL state, use TOS for objects, and have no local durable state.
- APIG routes `/mcp` and `/v1/*` to the runtime function, and `/api/*` plus the
  console to the control-plane function.

The protected customer host `101.126.155.97` is explicitly outside this
deployment and rollback boundary.

## Gates

Copy `config.example.json` outside the repository and fill only approved
resource IDs. Do not put secret values in the file. `preflight.sh` rejects
missing DRC bindings, a mutable image reference, the wrong source SHA, or
partial Identity configuration.

The public VeFaaS API describes ordinary environment values but does not expose
a KMS Secret reference field. Database credentials, the Admin Token, the
Runtime API Key, the encryption key, and TOS credentials must therefore be
injected through the approved DRC/secret binding before a function is released.
Plaintext secret values in `Envs` are prohibited.

Identity is optional for the first corrected deployment. If issuer, audience,
JWKS URI, UserPool, and Client are not all approved and available, deploy and
verify the Runtime API Key path, then report Identity/WorkBuddy as the sole
external blocker.

## Release

After DRC resources and bindings are approved:

1. Run `preflight.sh`.
2. Run `deploy-vefaas.sh`. New function IDs are printed before the script stops
   for DRC secret binding. Add those IDs to the external config, bind the
   approved resources, then rerun to update and release with `MinInstance=1`.
3. Create a dedicated HTTPS APIG service and two VeFaaS upstreams. Record their
   IDs, run `create-apig-upstreams.sh` when only upstreams are missing, then run
   `deploy-apig.sh` to create the four path routes.
4. Run `verify.sh` with a mode-0600 Runtime API Key file.

All Volcengine calls use `---profile default`. VeFaaS releases use rolling
traffic. `rollback.sh` releases the previous recorded revisions. Evidence
belongs under `/tmp/data-workshop-v1-v3/w4-corrected/` and must never contain
credentials.
