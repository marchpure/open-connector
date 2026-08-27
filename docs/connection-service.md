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
