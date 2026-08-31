# ECS deployment profile

This profile deploys the exact frozen source commit as one long-running container on a Linux AMD64
ECS instance. The instance must have a retained data disk attached as `/dev/vdb`, `/dev/nvme1n1`, or
`/dev/sdb` and inbound TCP 80/443.

`cloud-init.sh`:

- checks out exact commit `e76e00e33652aa3cd00d935e2b5634d3f970ae38`;
- builds an AMD64 image locally and records its content-addressed image ID;
- generates runtime secrets on the instance with mode `0600`;
- mounts the retained data disk at `/srv/knowledge-dev-connection-service`;
- runs one restartable, read-only, non-root Connection Service container;
- defaults to the application's public-only egress policy and empty database allowlist;
- supports direct Caddy HTTPS or HTTP origin mode behind a managed HTTPS gateway;
- persists Caddy's ACME account and certificate state outside the systemd read-only filesystem;
- disables proxy response buffering and proxy read/write timeouts for long-lived SSE.

The OAuth callback is `<public-origin>/oauth/callback`. The public origin and image digest are stored
on the instance at `/var/lib/knowledge-dev-connection-service-origin` and
`/var/lib/knowledge-dev-connection-service-image-digest`.

For a managed TLS edge, set `PUBLIC_ORIGIN` to the gateway's stable HTTPS URL and
`CADDY_SITE_ADDRESS=:80`; point the gateway upstream at the instance's private port 80. Set
`SOURCE_ARCHIVE_URL`, `IMAGE_ARCHIVE_URL`, and `CADDY_ARCHIVE_URL` to authenticated artifact URLs
when public package registries are unavailable.

For an explicitly permitted private database, set `CONNECTION_SERVICE_EGRESS_POLICY`,
`OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK`, and `CONNECTION_DATABASE_EGRESS_ALLOWLIST`. The deployed
test backend uses `private-allowlist`, `true`, and the database's single private IP respectively;
its database port is not exposed by the public security group.

`cloud-e2e.mjs` validates the public endpoint against a real PostgreSQL backend. It requires
`CONNECTION_SERVICE_TEST_ORIGIN`, `CONNECTION_SERVICE_AUTH_SECRET`, `POSTGRES_PASSWORD`, and
optionally `POSTGRES_HOST`.
