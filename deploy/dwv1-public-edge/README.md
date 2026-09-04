# DWV1 W4 public edge

This deployment package owns only the dev cloud data plane and public edge. It
does not deploy AgentKit MCP Gateway or OpenViking and does not add product UI.

## Corrected integration input

The deployment is frozen to corrected I1 commit
`20b966a0bdcbbcef55d8cba33ef5c380b2502efe`, which integrates corrected W1
`34e6be5a417521ce9183656b164061cb1bbce5d5` and corrected W2
`2f5759d72bd4ecee7712d3954362c6b735d712d3`.

The ECS/Caddy layout was derived file-by-file from the read-only donor
`data-workshop-p0-connection-ecs` commit `dc103ff`. This package replaces the
donor's source SHA, runtime topology, proxy policy, and deployment mechanics.

## Required inputs

Copy `.env.example` to an out-of-repository secret file on the target host.
Every image must use `repository@sha256:digest` form. I1 promotes a build by
changing only `OPEN_CONNECTOR_IMAGE`; tags are rejected.

Before any container change, `promotion-preflight.sh` requires the exact
corrected I1/W1/W2 SHAs and a registry-resolvable digest. Identity settings are
optional as a complete group. When supplied, the preflight requires approved
issuer/JWKS/audience/UserPool references, a live JWKS with signing keys, and MCP
protected-resource metadata that points to the approved issuer. An absent
identity group is reported as `IDENTITY_PENDING` without blocking the Runtime
API Key deployment.

The application and migration URLs may use distinct PostgreSQL roles. The
included PostgreSQL and MinIO containers provide the dev state and
S3-compatible object store without creating unrelated cloud resources.
Production secrets are generated or injected on the host and never written to
evidence.

## Deploy

```sh
sudo install -d -m 0750 /opt/dwv1-w4
sudo install -m 0644 compose.yaml Caddyfile contract-backend.mjs /opt/dwv1-w4/
sudo install -m 0755 deploy.sh rollback.sh verify.sh promotion-preflight.sh /opt/dwv1-w4/
sudo /opt/dwv1-w4/deploy.sh /etc/dwv1-w4.env
```

`deploy.sh` validates the frozen SHA and registry digest, migrates PostgreSQL,
starts the protected Control Plane, writes the approved identity configuration
through its authenticated internal API, then starts the inactive blue/green MCP
Runtime slot. It verifies health, switches Caddy, verifies the public edge, and
then stops the old Runtime slot. Both roles use the same immutable image,
PostgreSQL, and object store. It records a secret-free release receipt.
Docker's local log driver rotates at
10 MiB with five files. Health checks and restart policies provide monitoring;
the receipt and `docker compose ps` provide rollout state.

The corrected deployment must use a dedicated dev runtime. The protected
customer environment at `101.126.155.97` is never a deployment target.

After this release is deployed, the browser-readable, secret-free evidence URL
is:

```text
${PUBLIC_ORIGIN}/edge-contract/evidence
```

APIG forwards to Caddy on port 80. It must preserve `Authorization`,
`Mcp-Session-Id`, `Last-Event-ID`, `Accept`, and `Content-Type`; disable request
and response buffering/cache for `/mcp*`; and keep an idle timeout suitable for
streaming. Caddy does not log requests, so bearer values cannot enter proxy
logs.

## Verify

```sh
sudo /opt/dwv1-w4/verify.sh /etc/dwv1-w4.env
```

The script verifies HTTPS health, no-store policy, protected real MCP routing,
the browser evidence response, and contract SSE streaming with a synthetic
non-user bearer. It writes only boolean/header-shape facts to
`/tmp/data-workshop-v1-v3/w4-corrected/https-smoke.json`; it never writes a
token. The contract probe verifies header and streaming behavior only and is
never reported as OAuth evidence.

## Roll back

```sh
sudo /opt/dwv1-w4/rollback.sh /etc/dwv1-w4.env
```

Rollback reads the previous digest from the secret-free receipt, recreates the
runtime, waits for health, and reloads Caddy. PostgreSQL and object-store
volumes are retained. Database-incompatible releases require restoring the
matching external snapshot before traffic is re-enabled.
