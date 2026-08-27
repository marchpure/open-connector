# Connection Service V1

This checkout contains the OpenConnector kernel and the independent,
tenant-scoped Connection Service control/runtime boundary.

The control API is served at `/v1` and requires a bearer token created with
the deployment `CONNECTION_SERVICE_AUTH_SECRET`. The token payload is an
opaque, HMAC-signed server-issued `TenantPrincipal`; browser clients must not
construct tenant or owner identity in request bodies.

The service stores credentials with AES-GCM when
`CONNECTION_SERVICE_ENCRYPTION_KEY` is configured. Connection responses and
execution audit summaries are redacted DTOs. Lease tokens are short-lived,
explicitly scoped to non-empty `connectionIds` and `allowedActions`, and only
their SHA-256 hashes are persisted.

The catalog endpoint is an enablement view. Provider directory size is not a
readiness claim. A connector may be labelled `verified` only after the
corresponding real E2E evidence is recorded in the deployment configuration.

Local deployment:

```sh
CONNECTION_SERVICE_AUTH_SECRET="$(openssl rand -hex 32)" \
CONNECTION_SERVICE_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
npm run start:connection-service
```

The runtime uses the OpenConnector Provider/Action schemas, credential
validation/encryption, OAuth implementation, guarded provider fetch,
idempotency, runtime logs, MCP, and transit-file primitives. The control API
does not expose OpenConnector's `/api` management surface.

Web Discovery runs as a separate, one-session browser worker. Start a
15-minute Connection Service session first, then run the worker with only that
session's approved origin, page URL, service identity, and one-time worker
token:

```sh
docker build -f Dockerfile.web-discovery-worker -t connection-web-discovery .
docker run --rm --read-only --cap-drop=ALL \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  --network <tenant-egress-network> \
  -e WEB_DISCOVERY_SERVICE_BASE_URL=https://connection-service.internal \
  -e WEB_DISCOVERY_SESSION_ID=<session-id> \
  -e WEB_DISCOVERY_WORKER_TOKEN=<short-lived-worker-token> \
  -e WEB_DISCOVERY_SERVICE_BEARER=<short-lived-service-identity> \
  -e WEB_DISCOVERY_APPROVED_ORIGIN=https://app.example.com \
  -e WEB_DISCOVERY_PAGE_URL=https://app.example.com \
  connection-web-discovery
```

Each run creates a new browser context, blocks service workers and
cross-origin network requests, removes cookies/auth/CSRF values and sensitive
JSON fields, drops query strings, and forwards only JSON XHR/fetch
observations. An optional read-only
`WEB_DISCOVERY_STORAGE_STATE_PATH` mount can carry a user-authorized browser
session into the worker; it is never submitted to Connection Service.
Destroy the container and revoke the discovery session if capture fails.

License and supply-chain checks:

```sh
npm run typecheck
npm run lint
npm audit --audit-level=high
npm ls --all --json > artifacts/npm-sbom.json
```

`LICENSE.txt` and `NOTICE.md` remain the upstream Apache-2.0 notices. The SBOM
output is generated during release verification and is not a provider support
claim.
