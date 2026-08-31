#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
env_file=$(mktemp)
cleanup() {
  docker compose --env-file "$env_file" -f "$root_dir/deploy/connection-service/compose.e2e.yaml" down --volumes --remove-orphans
  rm -f "$env_file"
}
trap cleanup EXIT HUP INT TERM

umask 077
auth_secret=$(openssl rand -hex 32)
encryption_key=$(openssl rand -hex 32)
postgres_password=$(openssl rand -hex 24)
{
  printf 'CONNECTION_SERVICE_AUTH_SECRET=%s\n' "$auth_secret"
  printf 'CONNECTION_SERVICE_ENCRYPTION_KEY=%s\n' "$encryption_key"
  printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
} >"$env_file"

docker compose --env-file "$env_file" -f "$root_dir/deploy/connection-service/compose.e2e.yaml" up \
  --build --wait --wait-timeout 180
connection_id=$(docker compose --env-file "$env_file" -f "$root_dir/deploy/connection-service/compose.e2e.yaml" ps -q connection)
image_id=$(docker inspect --format '{{.Image}}' "$connection_id")
test "$(docker image inspect --format '{{.Architecture}}' "$image_id")" = "amd64"
test "$(docker image inspect --format '{{.Config.User}}' "$image_id")" = "node"
test "$(docker inspect --format '{{.Config.User}}' "$connection_id")" = "1000:1000"

docker compose --env-file "$env_file" -f "$root_dir/deploy/connection-service/compose.e2e.yaml" exec \
  -T connection node deploy/connection-service/container-e2e.ts

logs=$(docker compose --env-file "$env_file" -f "$root_dir/deploy/connection-service/compose.e2e.yaml" logs connection)
if printf '%s' "$logs" | grep -F -e "$auth_secret" -e "$encryption_key" -e "$postgres_password" >/dev/null; then
  echo "Generated secret material appeared in connection service logs." >&2
  exit 1
fi

docker compose --env-file "$env_file" -f "$root_dir/deploy/connection-service/compose.e2e.yaml" stop --timeout 10 connection
test "$(docker inspect --format '{{.State.ExitCode}}' "$connection_id")" = "0"
printf '%s\n' '{"status":"PASSED","checks":{"imageArchitecture":"amd64","imageUser":"node","runtimeUser":"1000:1000","secretRedaction":"PASSED","sigtermExit":"PASSED"}}'
