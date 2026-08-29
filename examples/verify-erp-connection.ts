/**
 * Reproducible real-tenant smoke test for any P4 ERP provider.
 *
 * Required environment: CONNECTION_SERVICE_URL, CONNECTION_SERVICE_TOKEN,
 * ERP_SERVICE, ERP_AUTH_TYPE, ERP_CREDENTIAL_VALUES (JSON), ERP_DOMAIN_A,
 * ERP_DOMAIN_B. The script performs create/validate, revision-scoped metadata
 * discovery, capability discovery, two bounded reads through Agent leases,
 * audit inspection, lease revocation, and connection deletion. It never
 * prints credentials or ERP rows.
 */

const origin = required("CONNECTION_SERVICE_URL").replace(/\/+$/u, "");
const token = required("CONNECTION_SERVICE_TOKEN");
const service = required("ERP_SERVICE");
const authType = required("ERP_AUTH_TYPE");
const values = JSON.parse(required("ERP_CREDENTIAL_VALUES")) as Record<string, string>;
const domains = [required("ERP_DOMAIN_A"), required("ERP_DOMAIN_B")];
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const connectionName = `p4-${service}-${Date.now()}`;

const created = await jsonRequest("/v1/connections", {
  method: "POST",
  body: JSON.stringify({ service, authType, connectionName, values }),
});
const connectionId = String(created.connection.id);
const validation = await jsonRequest(`/v1/connections/${connectionId}/validate`, { method: "POST" });
assertSucceeded(validation.job, "validate");

const discoveryInvocationId = `${connectionName}-metadata-discovery`;
const discoveryLease = await issueLease(`${service}.discover_resources`, discoveryInvocationId);
const discovery = await jsonRequest(`/v1/connections/${connectionId}/discover`, {
  method: "POST",
  headers: {
    "x-connection-lease": discoveryLease.token,
    "x-connection-invocation-id": discoveryInvocationId,
    "x-connection-audience": "erp-verifier",
  },
});
assertSucceeded(discovery.job, "metadata discovery");
await revokeLease(discoveryLease.claims.jti);
await assertRevoked(
  `/v1/connections/${connectionId}/discover`,
  {
    method: "POST",
    headers: {
      "x-connection-lease": discoveryLease.token,
      "x-connection-invocation-id": discoveryInvocationId,
      "x-connection-audience": "erp-verifier",
    },
  },
  "discovery lease",
);

const invocationIds: string[] = [];
for (const action of ["discover_capabilities"]) {
  const invocationId = `${connectionName}-${action}`;
  invocationIds.push(invocationId);
  const lease = await issueLease(`${service}.${action}`, invocationId);
  await invoke(action, {}, lease.token, invocationId);
  await revokeLease(lease.claims.jti);
  await assertRevokedAction(action, {}, lease.token, invocationId);
}
for (const domain of domains) {
  const invocationId = `${connectionName}-list-${domain}`;
  invocationIds.push(invocationId);
  const lease = await issueLease(`${service}.list_entities`, invocationId);
  await invoke("list_entities", { domain, pageSize: 2 }, lease.token, invocationId);
  await revokeLease(lease.claims.jti);
  await assertRevokedAction("list_entities", { domain, pageSize: 2 }, lease.token, invocationId);
}

const audit = await jsonRequest("/v1/audit");
const auditedInvocations = new Set(
  Array.isArray(audit.items)
    ? audit.items
        .filter((item) => item?.connectionId === connectionId && item?.actionId?.startsWith(`${service}.`))
        .map((item) => item.invocationId)
    : [],
);
for (const invocationId of invocationIds) {
  if (!auditedInvocations.has(invocationId)) throw new Error(`Missing ERP audit evidence for ${invocationId}`);
}
await jsonRequest(`/v1/connections/${connectionId}`, { method: "DELETE", expectNoContent: true });
await assertStatus(`/v1/connections/${connectionId}`, { method: "GET" }, 404, "deleted connection");
console.log(JSON.stringify({ ok: true, service, validation: "passed", domains, audited: true, revoked: true }));

async function invoke(action: string, input: unknown, lease: string, invocationId: string) {
  const result = await jsonRequest(`/v1/runtime/actions/${service}.${action}`, {
    method: "POST",
    headers: { "x-connection-lease": lease },
    body: JSON.stringify({ connectionId, invocationId, audience: "erp-verifier", input }),
  });
  if (!result.ok) throw new Error(`${action} failed`);
}

function issueLease(actionId: string, invocationId: string): Promise<Record<string, any>> {
  return jsonRequest(`/v1/connections/${connectionId}/lease`, {
    method: "POST",
    body: JSON.stringify({
      allowedActions: [actionId],
      invocationId,
      audience: "erp-verifier",
      ttlSeconds: 300,
    }),
  });
}

async function revokeLease(jti: unknown): Promise<void> {
  await jsonRequest(`/v1/leases/${String(jti)}/revoke`, { method: "POST" });
}

async function assertRevoked(path: string, init: RequestInit, label: string): Promise<void> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (response.status !== 400 && response.status !== 401) {
    throw new Error(`${label} remained usable after revocation (HTTP ${response.status})`);
  }
}

async function assertRevokedAction(action: string, input: unknown, lease: string, invocationId: string): Promise<void> {
  await assertStatus(
    `/v1/runtime/actions/${service}.${action}`,
    {
      method: "POST",
      headers: { "x-connection-lease": lease },
      body: JSON.stringify({ connectionId, invocationId, audience: "erp-verifier", input }),
    },
    400,
    `${action} lease`,
  );
}

async function assertStatus(path: string, init: RequestInit, expected: number, label: string): Promise<void> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (response.status !== expected) {
    throw new Error(`${label} returned HTTP ${response.status}, expected ${expected}`);
  }
}

async function jsonRequest(
  path: string,
  init: RequestInit & { expectNoContent?: boolean } = {},
): Promise<Record<string, any>> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}`);
  if (init.expectNoContent) return {};
  return (await response.json()) as Record<string, any>;
}

function assertSucceeded(job: unknown, phase: string): void {
  if (!job || typeof job !== "object" || (job as { status?: string }).status !== "succeeded") {
    throw new Error(`${phase} did not succeed`);
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
