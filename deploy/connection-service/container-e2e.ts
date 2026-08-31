import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createPrincipalToken } from "../../src/control-plane/auth.ts";

const origin = "http://127.0.0.1:3400";
const authSecret = requiredEnv("CONNECTION_SERVICE_AUTH_SECRET");
const postgresPassword = requiredEnv("POSTGRES_PASSWORD");
const principal = {
  tenantId: "container-e2e",
  workspaceId: "container-e2e",
  subject: "container-e2e",
  ownerId: "container-e2e",
  audience: "knowledge-runtime",
};
const authorization = `Bearer ${createPrincipalToken(principal, authSecret)}`;
const headers = { authorization, "content-type": "application/json" };
const checks: Record<string, string> = {};

const health = await requestJson<{ ok: boolean }>("/health");
const ready = await requestJson<{ ready: boolean }>("/ready");
if (!health.ok || !ready.ready) throw new Error("Health or readiness check failed.");
checks.health = "PASSED";

const catalog = await requestJson<{ items: Array<{ service: string }> }>("/v1/catalog", { headers });
if (!catalog.items.some((item) => item.service === "postgresql"))
  throw new Error("Authenticated catalog lacks PostgreSQL.");
checks.authenticatedCatalog = "PASSED";

const form = new FormData();
form.set("file", new File(["name,value\ncloud,ready\n"], "cloud.csv", { type: "text/csv" }));
const uploaded = await requestJson<{ file: { fileId: string } }>("/v1/files", {
  method: "POST",
  headers: { authorization },
  body: form,
});
const preview = await requestJson<{ preview: { kind: string } }>(
  `/v1/files/${encodeURIComponent(uploaded.file.fileId)}/preview`,
  { headers: { authorization } },
);
if (preview.preview.kind !== "csv") throw new Error("Uploaded file preview was not CSV.");
checks.file = "PASSED";

const created = await requestJson<{ connection: { id: string } }>("/v1/connections", {
  method: "POST",
  headers,
  body: JSON.stringify({
    service: "postgresql",
    authType: "custom_credential",
    connectionName: "container-postgresql",
    values: {
      host: "postgres",
      port: "5432",
      database: "connection_test",
      username: "connection_test",
      password: postgresPassword,
      tls: "disable",
    },
  }),
});
checks.postgresql = "PASSED";

const invocationId = `container-e2e-${Date.now()}`;
const lease = await requestJson<{ token: string; claims: { jti: string } }>(
  `/v1/connections/${created.connection.id}/lease`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({
      allowedActions: ["postgresql.execute_read_query"],
      allowedResources: { schemas: ["pg_catalog"] },
      invocationId,
      audience: principal.audience,
    }),
  },
);
checks.lease = "PASSED";

const runtimeUrl = new URL(`${origin}/v1/runtime/mcp/sse`);
runtimeUrl.searchParams.set("connectionId", created.connection.id);
runtimeUrl.searchParams.set("invocationId", invocationId);
runtimeUrl.searchParams.set("audience", principal.audience);
const transport = new StreamableHTTPClientTransport(runtimeUrl, {
  requestInit: { headers: { "x-connection-lease": lease.token } },
});
const client = new Client({ name: "connection-container-e2e", version: "1.0.0" });
await client.connect(transport);
checks.mcpInitialize = "PASSED";
const tools = await client.listTools();
if (!tools.tools.some((tool) => tool.name === "execute_action")) throw new Error("MCP execute_action tool missing.");
checks.mcpToolsList = "PASSED";
const called = await client.callTool({
  name: "execute_action",
  arguments: {
    actionId: "postgresql.execute_read_query",
    input: {
      query: "select datname as cloud_ready from pg_catalog.pg_database where datname = current_database()",
    },
  },
});
if (called.isError || !JSON.stringify(called).includes("cloud_ready")) {
  throw new Error(`PostgreSQL MCP call failed: ${JSON.stringify(called)}`);
}
checks.mcpToolsCall = "PASSED";
await client.close();

const audit = await requestJson<{ items: Array<{ invocationId?: string; ok: boolean }> }>(
  `/v1/audit?invocationId=${encodeURIComponent(invocationId)}`,
  { headers },
);
if (!audit.items.some((item) => item.invocationId === invocationId && item.ok)) {
  throw new Error("Successful MCP call was not persisted in the audit feed.");
}
checks.audit = "PASSED";

await requestJson(`/v1/leases/${encodeURIComponent(lease.claims.jti)}/revoke`, {
  method: "POST",
  headers,
});
const revoked = await fetch(runtimeUrl, { method: "POST", headers: { "x-connection-lease": lease.token } });
if (revoked.ok) throw new Error("Revoked lease remained usable.");
checks.revoke = "PASSED";
checks.oracle = "BLOCKED_EXTERNAL: no Oracle credentials supplied";

console.log(JSON.stringify({ status: "PASSED", checks }, null, 2));

async function requestJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : (undefined as T);
  if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}: ${text}`);
  return body;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
