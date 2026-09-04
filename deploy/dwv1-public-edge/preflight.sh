#!/bin/sh
set -eu

config=${1:?usage: preflight.sh CONFIG_JSON}
expected_source=20b966a0bdcbbcef55d8cba33ef5c380b2502efe
expected_digest=sha256:d853446c637643990677feb7bbe21b24acd78e9a21446cc00a75e201ed942583
expected_registry=idv-order-discount-agent-test-cn-beijing.cr.volces.com

fail() {
  printf 'PREFLIGHT_FAILED: %s\n' "$1" >&2
  exit 1
}

test -f "$config" || fail "configuration file does not exist"
test "$(jq -r '.profile' "$config")" = default || fail "profile must be default"
test "$(jq -r '.region' "$config")" = cn-beijing || fail "region must be cn-beijing"
test "$(jq -r '.sourceSha' "$config")" = "$expected_source" || fail "source SHA mismatch"
image=$(jq -r '.image' "$config")
case "$image" in
"$expected_registry"/*@"$expected_digest") ;;
*) fail "image must use the corrected registry digest" ;;
esac

for path in \
  .controlPlane.name .controlPlane.command \
  .mcpRuntime.name .mcpRuntime.command \
  .drc.bindingId .drc.postgresResourceId .drc.tosResourceId \
  .drc.secretResourceId; do
  test -n "$(jq -r "$path // empty" "$config")" || fail "$path is missing"
done

test "$(jq -r '.controlPlane.command' "$config")" = "/usr/local/bin/open-connector control-plane" ||
  fail "control-plane command mismatch"
test "$(jq -r '.mcpRuntime.command' "$config")" = "/usr/local/bin/open-connector mcp-runtime" ||
  fail "mcp-runtime command mismatch"
test "$(jq -r '.runtime.port' "$config")" = 3000 || fail "runtime port must be 3000"
timeout=$(jq -r '.runtime.requestTimeout' "$config")
test "$timeout" -ge 1 && test "$timeout" -le 900 || fail "request timeout must be in 1..900"
test "$(jq -r '.runtime.minInstance' "$config")" -ge 1 || fail "MinInstance must be at least 1"

identity_count=$(jq '[.identity.issuer,.identity.audience,.identity.jwksUri,.identity.userPoolRef,.identity.clientRef] | map(select(length > 0)) | length' "$config")
test "$identity_count" = 0 || test "$identity_count" = 5 ||
  fail "identity settings must be entirely empty or entirely populated"

printf 'PREFLIGHT_READY'
test "$identity_count" = 5 && printf ' IDENTITY_CONFIGURED\n' || printf ' IDENTITY_PENDING\n'
