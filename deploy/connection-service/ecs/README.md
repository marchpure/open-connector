# ECS deployment profile

This profile deploys the exact frozen source commit as one long-running full Runtime container on a Linux AMD64
ECS instance. The instance must have a retained data disk attached as `/dev/vdb`, `/dev/nvme1n1`, or
`/dev/sdb` and inbound TCP 80/443.

`cloud-init.sh`:

- checks out exact commit `ad8c3ca2befd0e3f28e8feaa094d97b841a4e620`;
- builds an AMD64 image locally and records its content-addressed image ID;
- generates runtime secrets on the instance with mode `0600`;
- mounts the retained data disk at `/srv/knowledge-dev-connection-service`;
- runs one restartable, read-only, non-root OpenConnector Runtime container on `0.0.0.0:3000`;
- persists the Runtime database and encrypted connection/token metadata at `/app/data`;
- protects Admin API routes with the generated `OOMOL_CONNECT_ADMIN_TOKEN`;
- defaults to the application's public-only egress policy and empty database allowlist;
- supports direct Caddy HTTPS or HTTP origin mode behind a managed HTTPS gateway;
- persists Caddy's ACME account and certificate state outside the systemd read-only filesystem;
- disables proxy response buffering and proxy read/write timeouts for long-lived SSE.

The Web Console is `<public-origin>/`; the MCP endpoint is `<public-origin>/mcp`. The public origin and image digest are stored
on the instance at `/var/lib/knowledge-dev-connection-service-origin` and
`/var/lib/knowledge-dev-connection-service-image-digest`.

For a managed TLS edge, set `PUBLIC_ORIGIN` to the gateway's stable HTTPS URL and
`CADDY_SITE_ADDRESS=:80`; point the gateway upstream at the instance's private port 80. Set
`SOURCE_ARCHIVE_URL`, `IMAGE_ARCHIVE_URL`, and `CADDY_ARCHIVE_URL` to authenticated artifact URLs
when public package registries are unavailable.

For an explicitly permitted private database, set `OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK` and
`OOMOL_CONNECT_EGRESS_TRUSTED_HOSTS`. Its database port must not be exposed by the public security group.

`cloud-e2e.mjs` is a legacy Connection Service probe and is not the P0 Runtime gate. Runtime verification
must use the full image and requires
`OOMOL_CONNECT_ADMIN_TOKEN`, `POSTGRES_PASSWORD`, and
optionally `POSTGRES_HOST`.
