import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHmac } from "node:crypto";

const origin = requiredEnv("CONNECTION_SERVICE_TEST_ORIGIN");
const authSecret = requiredEnv("CONNECTION_SERVICE_AUTH_SECRET");
const postgresPassword = requiredEnv("POSTGRES_PASSWORD");
const principal = {
  tenantId: "cloud-e2e",
  workspaceId: "cloud-e2e",
  subject: "cloud-e2e",
  ownerId: "cloud-e2e",
  audience: "knowledge-runtime",
};
const payload = Buffer.from(JSON.stringify(principal), "utf8").toString("base64url");
const signature = createHmac("sha256", authSecret).update(payload).digest("base64url");
const authorization = `Bearer cp1.${payload}.${signature}`;
const headers = { authorization, "content-type": "application/json" };
const checks = {};

const health = await requestJson("/health");
const ready = await requestJson("/ready");
assert(health.ok && ready.ready, "health/readiness failed");
checks.health = "PASSED";
checks.readiness = "PASSED";

const catalog = await requestJson("/v1/catalog", { headers });
assert(catalog.items.some((item) => item.service === "postgresql"), "PostgreSQL missing from catalog");
checks.catalog = "PASSED";

const created = await requestJson("/v1/connections", {
  method: "POST",
  headers,
  body: JSON.stringify({
    service: "postgresql",
    authType: "custom_credential",
    connectionName: "cloud-postgresql",
    values: {
      host: process.env.POSTGRES_HOST ?? "127.0.0.1",
      port: "5432",
      database: "connection_test",
      username: "connection_test",
      password: postgresPassword,
      tls: "disable",
    },
  }),
});
const connectionId = created.connection.id;
checks.create = "PASSED";

const validation = await requestJson(`/v1/connections/${connectionId}/validate`, {
  method: "POST",
  headers,
});
assert(validation.job.status === "succeeded", "connection validation failed");
checks.validate = "PASSED";
const validationJob = await requestJson(`/v1/jobs/${validation.job.id}`, { headers });
assert(validationJob.job.status === "succeeded", "validation job lookup failed");
checks.job = "PASSED";

const invocationId = `cloud-e2e-${Date.now()}`;
const lease = await requestJson(`/v1/connections/${connectionId}/lease`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    allowedActions: ["postgresql.discover_resources", "postgresql.execute_read_query"],
    allowedResources: { schemas: ["pg_catalog"] },
    invocationId,
    audience: principal.audience,
  }),
});
checks.lease = "PASSED";

const discovery = await requestJson(`/v1/connections/${connectionId}/discover`, {
  method: "POST",
  headers: {
    ...headers,
    "x-connection-lease": lease.token,
    "x-connection-invocation-id": invocationId,
    "x-connection-audience": principal.audience,
  },
});
assert(discovery.job.status === "succeeded", "resource discovery failed");
checks.discover = "PASSED";

const runtimeUrl = new URL(`${origin}/v1/runtime/mcp/sse`);
runtimeUrl.searchParams.set("connectionId", connectionId);
runtimeUrl.searchParams.set("invocationId", invocationId);
runtimeUrl.searchParams.set("audience", principal.audience);
const transport = new StreamableHTTPClientTransport(runtimeUrl, {
  requestInit: { headers: { "x-connection-lease": lease.token } },
});
const client = new Client({ name: "connection-cloud-e2e", version: "1.0.0" });
await client.connect(transport);
checks.mcpInitialize = "PASSED";
const tools = await client.listTools();
assert(tools.tools.some((tool) => tool.name === "execute_action"), "MCP execute_action tool missing");
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
assert(
  !called.isError && JSON.stringify(called).includes("cloud_ready"),
  `MCP tools/call failed: ${JSON.stringify(called)}`,
);
checks.mcpToolsCall = "PASSED";
await client.close();

const audit = await requestJson(`/v1/audit?invocationId=${encodeURIComponent(invocationId)}`, { headers });
assert(audit.items.some((item) => item.invocationId === invocationId && item.ok), "audit entry missing");
checks.audit = "PASSED";

await requestJson(`/v1/leases/${encodeURIComponent(lease.claims.jti)}/revoke`, {
  method: "POST",
  headers,
});
const revoked = await fetch(runtimeUrl, {
  method: "POST",
  headers: { "x-connection-lease": lease.token },
});
assert(!revoked.ok, "revoked lease remained usable");
checks.revoke = "PASSED";

const oauthCallback = await fetch(`${origin}/oauth/callback`, { redirect: "manual" });
assert(oauthCallback.status === 400, "OAuth callback endpoint is unavailable");
checks.oauthCallback = "PASSED";

console.log(JSON.stringify({ status: "PASSED", connectionId, checks }));

async function requestJson(path, init = {}) {
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}: ${text}`);
  return body;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
