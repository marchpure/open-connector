#!/bin/sh
set -eu

config=${1:?usage: preflight.sh CONFIG_JSON}
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
expected_source=$(git -C "$root" rev-parse HEAD)
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
printf '%s' "$image" |
  grep -Eq "^$expected_registry/idv-order-discount-agent-test/knowledge-dev-connection-service:dwv1-w41-[a-f0-9]{12}(-r[0-9]+)?$" ||
  fail "VeFaaS image must use a unique dwv1-w41 source tag"
printf '%s' "$(jq -r '.imageDigest' "$config")" |
  grep -Eq '^sha256:[a-f0-9]{64}$' || fail "bootstrap registry digest is missing"

for path in \
  .controlPlane.name .controlPlane.command .controlPlane.role \
  .mcpRuntime.name .mcpRuntime.command .mcpRuntime.role \
  .network.vpcId .postgresql.instanceId .postgresql.endpoint \
  .postgresql.database .postgresql.account \
  .kms.secretName .kms.roleName .kms.policyName; do
  test -n "$(jq -r "$path // empty" "$config")" || fail "$path is missing"
done

test "$(jq -r '.controlPlane.command' "$config")" = "node /opt/dwv1-bootstrap/server.mjs" ||
  fail "control-plane command mismatch"
test "$(jq -r '.mcpRuntime.command' "$config")" = "node /opt/dwv1-bootstrap/server.mjs" ||
  fail "mcp-runtime command mismatch"
test "$(jq -r '.controlPlane.role' "$config")" = control-plane || fail "control-plane role mismatch"
test "$(jq -r '.mcpRuntime.role' "$config")" = mcp-runtime || fail "mcp-runtime role mismatch"
test "$(jq -r '.runtime.port' "$config")" = 8080 || fail "VeFaaS port must be 8080"
test "$(jq -r '.runtime.internalPort' "$config")" = 3000 || fail "OpenConnector port must be 3000"
test "$(jq -r '.network.subnetIds | length' "$config")" -gt 0 || fail "at least one subnet is required"
test "$(jq -r '.network.securityGroupIds | length' "$config")" -gt 0 ||
  fail "at least one VeFaaS security group is required"
test "$(jq -r '.postgresql.reuseApproved' "$config")" = true ||
  fail "PostgreSQL instance reuse is not approved"
test -n "$(jq -r '.kms.secretTrn' "$config")" || fail "KMS Secret TRN is missing"
test -n "$(jq -r '.kms.roleTrn' "$config")" || fail "VeFaaS role TRN is missing"
timeout=$(jq -r '.runtime.requestTimeout' "$config")
test "$timeout" -ge 1 && test "$timeout" -le 900 || fail "request timeout must be in 1..900"
test "$(jq -r '.runtime.minInstance' "$config")" -ge 1 || fail "MinInstance must be at least 1"

if test "$(jq -r '.tos.enabled' "$config")" = true; then
  test -n "$(jq -r '.tos.bucket' "$config")" || fail "TOS bucket is required when TOS is enabled"
fi

identity_count=$(jq '[.identity.issuer,.identity.audience,.identity.jwksUri,.identity.userPoolRef,.identity.clientRef] | map(select(length > 0)) | length' "$config")
test "$identity_count" = 0 || test "$identity_count" = 5 ||
  fail "identity settings must be entirely empty or entirely populated"
if test "$(jq -r '.identity.oauthCompatEnabled' "$config")" = true; then
  test "$identity_count" = 5 || fail "OAuth compatibility requires complete identity settings"
  for path in .identity.upstreamIssuer .identity.clientId .identity.scopes .identity.allowedRedirectUris; do
    test -n "$(jq -r "$path // empty" "$config")" || fail "$path is required for OAuth compatibility"
  done
  test "$(jq -r '.identity.clientId' "$config")" = "$(jq -r '.identity.clientRef' "$config")" ||
    fail "OAuth clientId and identity clientRef must match"
  printf '%s' "$(jq -r '.identity.allowedRedirectUris' "$config")" |
    grep -Eq '^workbuddy://workbuddy/mcp/custom-mcp%3A[^,[:space:]]+/oauth/callback(,workbuddy://workbuddy/mcp/custom-mcp%3A[^,[:space:]]+/oauth/callback)*$' ||
    fail "WorkBuddy redirect allowlist must contain exact connector callback URIs"
fi

printf 'PREFLIGHT_READY'
test "$identity_count" = 5 && printf ' IDENTITY_CONFIGURED\n' || printf ' IDENTITY_PENDING\n'
