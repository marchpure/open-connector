#!/bin/sh
set -eu

expected_base=20b966a0bdcbbcef55d8cba33ef5c380b2502efe
env_file=${1:-/etc/dwv1-w4.env}

fail() {
  printf 'BLOCKED_UPSTREAM: %s\n' "$1" >&2
  exit 1
}

test -f "$env_file" || fail "deployment environment file is missing"
set -a
. "$env_file"
set +a

test "${SOURCE_SHA:-}" = "$expected_base" || fail "SOURCE_SHA does not match corrected I1"
printf '%s' "${OPEN_CONNECTOR_IMAGE:-}" |
  grep -Eq '^[-./a-zA-Z0-9_:]+@sha256:[a-f0-9]{64}$' ||
  fail "OPEN_CONNECTOR_IMAGE is not pinned by exact digest"
docker manifest inspect "$OPEN_CONNECTOR_IMAGE" >/dev/null 2>&1 ||
  fail "OPEN_CONNECTOR_IMAGE digest is unavailable from the registry"
printf '%s' "${W1_SOURCE_SHA:-}" | grep -Eq '^[a-f0-9]{40}$' ||
  fail "W1_SOURCE_SHA handoff is missing"
printf '%s' "${W2_SOURCE_SHA:-}" | grep -Eq '^[a-f0-9]{40}$' ||
  fail "W2_SOURCE_SHA handoff is missing"
test "$W1_SOURCE_SHA" = 34e6be5a417521ce9183656b164061cb1bbce5d5 ||
  fail "W1_SOURCE_SHA does not match the corrected handoff"
test "$W2_SOURCE_SHA" = 2f5759d72bd4ecee7712d3954362c6b735d712d3 ||
  fail "W2_SOURCE_SHA does not match the corrected handoff"

identity_count=0
for value_name in IDENTITY_ISSUER IDENTITY_JWKS_URI IDENTITY_AUDIENCE IDENTITY_USER_POOL_REF; do
  eval "value=\${$value_name:-}"
  test -z "$value" || identity_count=$((identity_count + 1))
done
test "$identity_count" = 0 || test "$identity_count" = 4 ||
  fail "identity configuration must provide issuer, JWKS, audience, and UserPool together"

if test "$identity_count" = 0; then
  printf 'PROMOTION_PREFLIGHT_READY IDENTITY_PENDING\n'
  exit 0
fi

test "${IDENTITY_ISSUER#https://}" != "$IDENTITY_ISSUER" ||
  fail "IDENTITY_ISSUER must use HTTPS"
test "${IDENTITY_JWKS_URI#https://}" != "$IDENTITY_JWKS_URI" ||
  fail "IDENTITY_JWKS_URI must use HTTPS"

issuer_metadata=$(curl --fail --silent --show-error --max-time 15 \
  "$IDENTITY_ISSUER/.well-known/oauth-authorization-server") ||
  fail "authorization-server metadata is unavailable"
metadata_issuer=$(printf '%s' "$issuer_metadata" | jq -r '.issuer // empty')
metadata_jwks=$(printf '%s' "$issuer_metadata" | jq -r '.jwks_uri // empty')
test "$metadata_issuer" = "$IDENTITY_ISSUER" ||
  fail "authorization-server issuer does not match IDENTITY_ISSUER"
test "$metadata_jwks" = "$IDENTITY_JWKS_URI" ||
  fail "authorization-server metadata does not publish the approved JWKS URI"

jwks=$(curl --fail --silent --show-error --max-time 15 "$IDENTITY_JWKS_URI") ||
  fail "approved JWKS endpoint is unavailable"
printf '%s' "$jwks" | jq -e '.keys | type == "array" and length > 0' >/dev/null ||
  fail "approved JWKS endpoint has no signing keys"

resource_metadata=$(curl --fail --silent --show-error --max-time 15 \
  "$PUBLIC_ORIGIN/.well-known/oauth-protected-resource/mcp") ||
  fail "MCP protected-resource metadata is unavailable"
resource=$(printf '%s' "$resource_metadata" | jq -r '.resource // empty')
printf '%s' "$resource_metadata" |
  jq -e --arg issuer "$IDENTITY_ISSUER" '.authorization_servers | index($issuer) != null' >/dev/null ||
  fail "MCP protected-resource metadata does not reference the approved issuer"
case "$resource" in
"$PUBLIC_ORIGIN"|"$PUBLIC_ORIGIN/mcp") ;;
*) fail "MCP protected-resource metadata has the wrong resource identifier" ;;
esac

printf 'PROMOTION_PREFLIGHT_READY\n'
