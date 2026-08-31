# Connection Service deployment

This directory is the production-oriented, single-replica container profile for Connection Service.
It creates no cloud resources by itself. Replace the example host, TLS secret name, image reference,
storage class/size, ingress class, and network policy with values owned by the target environment.

## Architecture and constraints

- Run exactly `replicas: 1` with `Recreate`. SQLite and `RuntimeMcpSseSessions` are process-local.
  This release is not multi-replica capable until both state stores are externalized.
- Run the image as Linux AMD64. The Dockerfile, Compose verification, and pod node selector make that
  target explicit.
- Mount a `ReadWriteOnce` persistent volume at `/app/data/connection-service`. It contains
  `control.sqlite`, its WAL files, transit files, and upload state.
- Run UID/GID 1000 with no Linux capabilities, no privilege escalation, a read-only root filesystem,
  no Kubernetes API token, and a runtime-default seccomp profile.
- Terminate TLS at Ingress, APIG, or the load balancer. The container listens on HTTP only.
  `CONNECTION_SERVICE_PUBLIC_ORIGIN` must be the stable external HTTPS origin. The OAuth callback is
  always `https://<domain>/oauth/callback`.
- The dedicated MCP SSE ingress disables response/request buffering, uses HTTP/1.1, and sets one-hour
  read/send timeouts. Configure equivalent settings when APIG or another load balancer replaces
  ingress-nginx; its idle timeout must exceed the longest expected MCP session.
- The first release has an explicit egress mode. `public-only` denies private destinations in the
  application and network policy. To reach private PostgreSQL or Oracle, use
  `private-allowlist`, set `OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK=true`, populate
  `CONNECTION_DATABASE_EGRESS_ALLOWLIST`, and narrow the NetworkPolicy CIDRs to approved database
  endpoints.
- `oracledb` runs in Thin mode; Oracle Instant Client is not required. Real Oracle verification still
  requires a reachable Oracle database and credentials.

## Required configuration

Non-secret values live in `configmap.yaml`. Secrets must be provisioned separately by the deployment
system; do not commit them:

```sh
kubectl -n <namespace> create secret generic connection-service-secrets \
  --from-literal=auth-secret='<random-at-least-32-character-value>' \
  --from-literal=encryption-key='<different-random-at-least-32-character-value>'
```

Startup fails before listening unless both secrets are strong and distinct, the public origin is a
path-free HTTPS origin, the data directory is writable and SQLite-capable, and the selected egress
mode is internally consistent. Startup logs contain configuration categories and counts, not secret
values. API audit payloads pass through the existing recursive secret redactor.

## Deploy runbook

1. Build and publish an immutable AMD64 image:

   ```sh
   docker buildx build --platform linux/amd64 \
     -f Dockerfile.connection-service \
     -t <registry>/connection-service:<git-sha> --push .
   ```

2. Copy this directory into an environment overlay. Set the HTTPS hostname/public origin, immutable
   image digest, TLS secret, storage settings, and environment-specific egress rules.
3. Provision `connection-service-secrets` out of band. Preserve the encryption key across deploys;
   changing it without an explicit data migration makes stored credentials unreadable.
4. Validate before applying:

   ```sh
   kubectl kustomize deploy/connection-service >/tmp/connection-service.yaml
   kubectl apply --dry-run=server -f /tmp/connection-service.yaml
   ```

5. Apply during a maintenance window because `Recreate` intentionally causes a short outage:

   ```sh
   kubectl apply -f /tmp/connection-service.yaml
   kubectl rollout status deployment/connection-service --timeout=5m
   ```

6. Verify `GET /health`, `GET /ready`, an authenticated `GET /v1/catalog`, OAuth callback URL
   generation, file upload/preview, a scoped database lease, MCP initialize/list/call, audit, revoke,
   and logs for accidental credential output. Run the local container gate below before promotion.

## Local container gate

Docker must support Linux AMD64 emulation when the host is not AMD64. The script creates ephemeral
secrets, builds the production image, starts a real PostgreSQL 17 container, and verifies image and
runtime architecture/user, health, readiness, authenticated catalog, file handling, PostgreSQL
credential validation, lease issuance, MCP initialize/tools-list/tools-call, audit persistence,
revoke enforcement, secret-free startup logs, and clean SIGTERM shutdown:

```sh
deploy/connection-service/run-container-e2e.sh
```

Oracle is `BLOCKED_EXTERNAL` unless a separately managed real Oracle endpoint and credentials are
available. Unit tests and a loaded Thin driver do not qualify as a real Oracle pass.

## Rollback runbook

1. Stop new traffic and preserve the PVC. Do not delete the Deployment, PVC, or secret.
2. If only the image changed, restore the previous immutable image:

   ```sh
   kubectl set image deployment/connection-service \
     connection-service=<registry>/connection-service@sha256:<previous-digest>
   kubectl rollout status deployment/connection-service --timeout=5m
   ```

3. If manifests changed, apply the last known-good rendered manifest. Keep `replicas: 1` and
   `Recreate`.
4. If persisted state changed incompatibly, scale to zero, restore a pre-deploy volume snapshot,
   restore the matching encryption secret, then scale to one. Never attach the SQLite PVC to two
   writers.
5. Confirm health/readiness and repeat authenticated catalog, file, PostgreSQL, lease, MCP, revoke,
   and audit checks. Re-enable traffic only after those pass.

The service is a stateful, long-running container and must not be converted wholesale to VeFaaS.
