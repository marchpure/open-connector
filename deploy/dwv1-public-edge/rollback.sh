#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
env_file=${1:-/etc/dwv1-w4.env}
receipt=/var/lib/dwv1-w4/release.env

test -f "$receipt"
previous_image=$(sed -n 's/^PREVIOUS_IMAGE=//p' "$receipt")
current_slot=$(sed -n 's/^ACTIVE_SLOT=//p' "$receipt")
printf '%s' "$previous_image" |
  grep -Eq '^[-./a-zA-Z0-9_:]+@sha256:[a-f0-9]{64}$'
case "$current_slot" in
blue) rollback_slot=green ;;
green) rollback_slot=blue ;;
*) exit 1 ;;
esac

rollback_env=$(mktemp)
trap 'rm -f "$rollback_env"' EXIT
sed -e '/^OPEN_CONNECTOR_IMAGE=/d' -e '/^ACTIVE_SLOT=/d' "$env_file" >"$rollback_env"
printf 'OPEN_CONNECTOR_IMAGE=%s\n' "$previous_image" >>"$rollback_env"
printf 'ACTIVE_SLOT=runtime-%s\n' "$rollback_slot" >>"$rollback_env"
chmod 0600 "$rollback_env"

compose="docker compose --project-directory $root --env-file $rollback_env --profile $rollback_slot"
$compose run --rm migrate
$compose up -d --wait "runtime-$rollback_slot"
$compose up -d --wait caddy
"$root/verify.sh" "$rollback_env"
docker compose --project-directory "$root" --env-file "$rollback_env" \
  --profile "$current_slot" stop "runtime-$current_slot"

cat >"$receipt.tmp" <<EOF
SOURCE_SHA=$(sed -n 's/^SOURCE_SHA=//p' "$receipt")
CURRENT_IMAGE=$previous_image
CURRENT_REPO_DIGEST=$(docker image inspect --format '{{index .RepoDigests 0}}' "$previous_image")
PREVIOUS_IMAGE=$(sed -n 's/^CURRENT_IMAGE=//p' "$receipt")
ACTIVE_SLOT=$rollback_slot
PUBLIC_ORIGIN=$(sed -n 's/^PUBLIC_ORIGIN=//p' "$receipt")
DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
chmod 0644 "$receipt.tmp"
mv "$receipt.tmp" "$receipt"
