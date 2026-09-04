#!/bin/sh
set -eu

expected_sha=20b966a0bdcbbcef55d8cba33ef5c380b2502efe
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
env_file=${1:-/etc/dwv1-w4.env}
receipt_dir=/var/lib/dwv1-w4
receipt=$receipt_dir/release.env

test -f "$env_file"
test "$(stat -c %a "$env_file")" = 600
set -a
. "$env_file"
set +a

test "${SOURCE_SHA:?required}" = "$expected_sha"
printf '%s' "${OPEN_CONNECTOR_IMAGE:?required}" |
  grep -Eq '^[-./a-zA-Z0-9_:]+@sha256:[a-f0-9]{64}$'
test "${PUBLIC_ORIGIN#https://}" != "$PUBLIC_ORIGIN"
"$root/promotion-preflight.sh" "$env_file"

mkdir -p "$receipt_dir"
previous_image=""
current_slot=""
if test -f "$receipt"; then
  previous_image=$(sed -n 's/^CURRENT_IMAGE=//p' "$receipt")
  current_slot=$(sed -n 's/^ACTIVE_SLOT=//p' "$receipt")
fi
case "$current_slot" in
blue) next_slot=green ;;
green) next_slot=blue ;;
*) next_slot=blue ;;
esac

slot_env=$(mktemp)
trap 'rm -f "$slot_env"' EXIT
sed '/^ACTIVE_SLOT=/d' "$env_file" >"$slot_env"
printf 'ACTIVE_SLOT=runtime-%s\n' "$next_slot" >>"$slot_env"
chmod 0600 "$slot_env"

compose="docker compose --project-directory $root --env-file $slot_env --profile $next_slot"
$compose config --quiet
$compose pull
$compose up -d postgres object-store
$compose run --rm object-store-init
$compose run --rm migrate
$compose up -d --wait control-plane contract
if test -n "${IDENTITY_ISSUER:-}"; then
  $compose exec -T control-plane node /app/configure-identity.mjs
fi
$compose up -d --wait "runtime-$next_slot"
$compose up -d --wait caddy
"$root/verify.sh" "$slot_env"
if test -n "$current_slot"; then
  docker compose --project-directory "$root" --env-file "$slot_env" \
    --profile "$current_slot" stop "runtime-$current_slot"
fi

actual_digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$OPEN_CONNECTOR_IMAGE")
cat >"$receipt.tmp" <<EOF
SOURCE_SHA=$SOURCE_SHA
CURRENT_IMAGE=$OPEN_CONNECTOR_IMAGE
CURRENT_REPO_DIGEST=$actual_digest
PREVIOUS_IMAGE=$previous_image
ACTIVE_SLOT=$next_slot
PUBLIC_ORIGIN=$PUBLIC_ORIGIN
DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
chmod 0644 "$receipt.tmp"
mv "$receipt.tmp" "$receipt"
