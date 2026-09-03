# DWV1 W4 public edge

This deployment package owns only the dev cloud data plane and public edge. It
does not deploy AgentKit MCP Gateway or OpenViking and does not add product UI.

## Current integration state

`BLOCKED_UPSTREAM`: the frozen source
`0fa2c728dfbf957735da2843ec2b8a4f3425b105` contains the OpenConnector console
and stateless `POST /mcp`, but the W1 enhanced runtime and W2 WorkBuddy
UserPool/Client branches have no commits beyond that frozen source. The real
runtime remains the `/mcp` backend. `/edge-contract/mcp` is a separately
labelled protocol probe; it is not an end-to-end substitute.

The ECS/Caddy layout was derived file-by-file from the read-only donor
`data-workshop-p0-connection-ecs` commit `dc103ff`. This package replaces the
donor's source SHA, runtime topology, proxy policy, and deployment mechanics.

## Required inputs

Copy `.env.example` to an out-of-repository secret file on the target host.
Every image must use `repository@sha256:digest` form. I1 promotes a build by
changing only `OPEN_CONNECTOR_IMAGE`; tags are rejected.

The application and migration URLs may use distinct PostgreSQL roles. The
included PostgreSQL and MinIO containers provide the dev state and
S3-compatible object store without creating unrelated cloud resources.
Production secrets are generated or injected on the host and never written to
evidence.

## Deploy

```sh
sudo install -d -m 0750 /opt/dwv1-w4
sudo install -m 0644 compose.yaml Caddyfile contract-backend.mjs /opt/dwv1-w4/
sudo install -m 0755 deploy.sh rollback.sh verify.sh /opt/dwv1-w4/
sudo /opt/dwv1-w4/deploy.sh /etc/dwv1-w4.env
```

`deploy.sh` validates the frozen SHA and digest pins, migrates PostgreSQL,
starts the inactive blue/green runtime slot, verifies its health, switches
Caddy, verifies the public edge, and then stops the old slot. It records a
secret-free release receipt. Docker's local log driver rotates at
10 MiB with five files. Health checks and restart policies provide monitoring;
the receipt and `docker compose ps` provide rollout state.

The stable dev origin currently allocated by APIG is:

```text
https://s4j054gh1e125mqsipi2e.apigateway-cn-beijing.volceapi.com
```

After this release is deployed, the browser-readable, secret-free evidence URL
is:

```text
https://s4j054gh1e125mqsipi2e.apigateway-cn-beijing.volceapi.com/edge-contract/evidence
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
`/tmp/data-workshop-v1-v3/w4/latest.json`; it never writes a token.
WorkBuddy OAuth remains blocked until the approved W2 UserPool/Client contract
is merged and configured.

## Roll back

```sh
sudo /opt/dwv1-w4/rollback.sh /etc/dwv1-w4.env
```

Rollback reads the previous digest from the secret-free receipt, recreates the
runtime, waits for health, and reloads Caddy. PostgreSQL and object-store
volumes are retained. Database-incompatible releases require restoring the
matching external snapshot before traffic is re-enabled.
