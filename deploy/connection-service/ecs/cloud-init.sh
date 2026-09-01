#!/bin/bash
set -euo pipefail

exec > >(tee -a /var/log/knowledge-dev-connection-service-bootstrap.log) 2>&1

source_sha="ad8c3ca2befd0e3f28e8feaa094d97b841a4e620"
source_archive_url="${SOURCE_ARCHIVE_URL:-https://github.com/oomol-lab/open-connector/archive/$source_sha.tar.gz}"
image_archive_url="${IMAGE_ARCHIVE_URL:-}"
caddy_archive_url="${CADDY_ARCHIVE_URL:-}"
caddy_site_address="${CADDY_SITE_ADDRESS:-}"
egress_policy="${CONNECTION_SERVICE_EGRESS_POLICY:-public-only}"
allow_private_network="${OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK:-false}"
database_egress_allowlist="${CONNECTION_DATABASE_EGRESS_ALLOWLIST:-}"
install_dir="/opt/knowledge-dev-connection-service"
data_dir="/srv/knowledge-dev-connection-service"
secret_file="/etc/knowledge-dev-connection-service.env"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl docker.io git openssl
systemctl enable --now docker

data_device=""
for candidate in /dev/vdb /dev/nvme1n1 /dev/sdb; do
  if [[ -b "$candidate" ]]; then
    data_device="$candidate"
    break
  fi
done
if [[ -z "$data_device" ]]; then
  echo "No persistent data disk found." >&2
  exit 1
fi
if ! blkid "$data_device" >/dev/null 2>&1; then
  mkfs.ext4 -F "$data_device"
fi
mkdir -p "$data_dir"
data_uuid=$(blkid -s UUID -o value "$data_device")
if ! grep -q "UUID=$data_uuid" /etc/fstab; then
  printf 'UUID=%s %s ext4 defaults,nofail 0 2\n' "$data_uuid" "$data_dir" >>/etc/fstab
fi
mount "$data_dir" || true
chown 1000:1000 "$data_dir"
chmod 0700 "$data_dir"

rm -rf "$install_dir"
mkdir -p "$install_dir"
curl --fail --location --retry 5 "$source_archive_url" |
  tar -xz --strip-components=1 -C "$install_dir"
printf '%s\n' "$source_sha" >"$install_dir/SOURCE_SHA"

if [[ -n "$image_archive_url" ]]; then
  curl --fail --location --retry 5 "$image_archive_url" | gzip -dc | docker load
  docker tag \
    "idv-order-discount-agent-test-cn-beijing.cr.volces.com/idv-order-discount-agent-test/knowledge-dev-connection-service:$source_sha" \
    "knowledge-dev-connection-service:$source_sha"
else
  docker build --platform linux/amd64 \
    -f "$install_dir/docker/Dockerfile" \
    -t "knowledge-dev-connection-service:$source_sha" \
    "$install_dir"
fi
image_id=$(docker image inspect --format '{{.Id}}' "knowledge-dev-connection-service:$source_sha")
printf '%s\n' "$image_id" >/var/lib/knowledge-dev-connection-service-image-digest

public_origin="${PUBLIC_ORIGIN:-}"
if [[ -z "$public_origin" ]]; then
  public_ip=$(curl --fail --silent --show-error --ipv4 https://api.ipify.org)
  public_host="${public_ip//./-}.sslip.io"
  public_origin="https://$public_host"
else
  public_host="${public_origin#https://}"
fi
if [[ -z "$caddy_site_address" ]]; then
  caddy_site_address="$public_host"
fi

umask 077
if [[ ! -f "$secret_file" ]]; then
  : >"$secret_file"
fi
sed -i \
  -e '/^NODE_ENV=/d' \
  -e '/^OOMOL_CONNECT_ADMIN_TOKEN=/d' \
  -e '/^OOMOL_CONNECT_ENCRYPTION_KEY=/d' \
  -e '/^HOST=/d' \
  -e '/^PORT=/d' \
  -e '/^OOMOL_CONNECT_DATA_DIR=/d' \
  -e '/^OOMOL_CONNECT_ORIGIN=/d' \
  -e '/^OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK=/d' \
  -e '/^OOMOL_CONNECT_EGRESS_TRUSTED_HOSTS=/d' \
  "$secret_file"
{
  printf 'NODE_ENV=production\n'
  printf 'HOST=0.0.0.0\n'
  printf 'PORT=3000\n'
  printf 'OOMOL_CONNECT_DATA_DIR=/app/data\n'
  printf 'OOMOL_CONNECT_ORIGIN=%s\n' "$public_origin"
  printf 'OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK=%s\n' "$allow_private_network"
  printf 'OOMOL_CONNECT_EGRESS_TRUSTED_HOSTS=%s\n' "$database_egress_allowlist"
} >>"$secret_file"
# Keep generated credentials at the end so normalization is idempotent and never
# removes them during a repeat bootstrap.
grep -q '^OOMOL_CONNECT_ADMIN_TOKEN=' "$secret_file" ||
  printf 'OOMOL_CONNECT_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" >>"$secret_file"
grep -q '^OOMOL_CONNECT_ENCRYPTION_KEY=' "$secret_file" ||
  printf 'OOMOL_CONNECT_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" >>"$secret_file"
chmod 0600 "$secret_file"

docker rm -f knowledge-dev-connection-service >/dev/null 2>&1 || true
docker run -d \
  --name knowledge-dev-connection-service \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --user 1000:1000 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=1g \
  --env-file "$secret_file" \
  --mount "type=bind,src=$data_dir,dst=/app/data" \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 \
  --health-cmd "node -e \"fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\"" \
  --health-interval 10s \
  --health-timeout 3s \
  --health-retries 6 \
  "$image_id"

mkdir -p /etc/knowledge-dev-caddy /srv/knowledge-dev-caddy
cat >/etc/knowledge-dev-caddy/Caddyfile <<EOF
$caddy_site_address {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1
    transport http {
      read_timeout 0
      write_timeout 0
    }
  }
}
EOF
if [[ -n "$caddy_archive_url" ]]; then
  curl --fail --location --retry 5 "$caddy_archive_url" |
    tar -xz -C /usr/local/bin caddy
  chmod 0755 /usr/local/bin/caddy
fi
cat >/etc/systemd/system/knowledge-dev-caddy.service <<'EOF'
[Unit]
Description=Knowledge Dev Connection HTTPS proxy
After=network-online.target docker.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/caddy run --config /etc/knowledge-dev-caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/knowledge-dev-caddy/Caddyfile
Restart=always
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/srv/knowledge-dev-caddy
Environment=HOME=/srv/knowledge-dev-caddy
Environment=XDG_DATA_HOME=/srv/knowledge-dev-caddy

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now knowledge-dev-caddy

printf '%s\n' "$public_origin" >/var/lib/knowledge-dev-connection-service-origin
echo "knowledge-dev-connection-service bootstrap complete"
