import type { ProviderDefinition } from "../src/core/types.ts";

import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCatalogStore } from "../src/catalog-store.ts";
import { createPrincipalToken } from "../src/control-plane/auth.ts";
import { createConnectionControlApp } from "../src/control-plane/server.ts";
import { setPrivateNetworkAccessAllowed } from "../src/core/request.ts";
import { closeOraclePools } from "../src/providers/oracle_database/runtime.ts";
import { ProviderLoader } from "../src/providers/provider-loader.ts";
import { AesGcmSecretCodec } from "../src/server/secrets/secret-codec.ts";

const host = requiredEnv("ORACLE_MCP_HOST");
const port = Number(requiredEnv("ORACLE_MCP_PORT"));
const password = requiredEnv("ORACLE_MCP_PASSWORD");
const schema = requiredEnv("ORACLE_MCP_SCHEMA").toUpperCase();
const table = requiredEnv("ORACLE_MCP_TABLE").toUpperCase();
const service = "oracle_database";
const principal = {
  tenantId: "oracle-mcp-e2e",
  workspaceId: "oracle-mcp-e2e",
  subject: "oracle-mcp-e2e",
  ownerId: "oracle-mcp-e2e",
  audience: "oracle-mcp-e2e",
};
const authSecret = "oracle-mcp-e2e-auth";
const runtimePort = 38120;

setPrivateNetworkAccessAllowed(true);
process.env.CONNECTION_DATABASE_EGRESS_ALLOWLIST = host;

const provider = (await import(`../src/providers/${service}/definition.ts`)) as { provider: ProviderDefinition };
const controlDatabase = new DatabaseSync(":memory:");
const catalog = createCatalogStore([provider.provider], {
  executableActionIds: provider.provider.actions.map((action) => action.id),
});
const app = createConnectionControlApp({
  catalog,
  providerLoader: new ProviderLoader({
    [service]: () => import(`../src/providers/${service}/executors.ts`),
  }),
  controlDatabase,
  secretCodec: new AesGcmSecretCodec("oracle-mcp-e2e-encryption"),
  authSecret,
  publicOrigin: "http://oracle-mcp.test",
  enablement: [{ service, tier: "verified", connectorDefinitionVersion: "1.0.0", owner: "w2" }],
});
const auth = `Bearer ${createPrincipalToken(principal, authSecret)}`;
const runtimeServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: runtimePort });

const connectionResponse = await app.request("/v1/connections", {
  method: "POST",
  headers: { authorization: auth, "content-type": "application/json" },
  body: JSON.stringify({
    service,
    authType: "custom_credential",
    connectionName: "oracle-mcp",
    values: {
      host,
      port: String(port),
      username: "step3b",
      password,
      tls: "disable",
      serviceName: "FREEPDB1",
      allowedSchemas: schema,
    },
  }),
});
const connectionBody = (await connectionResponse.json()) as { connection?: { id?: string } };
const connectionId = requiredString(connectionBody.connection?.id, "connection id");
const invocationId = "oracle-mcp-query";
const leaseResponse = await app.request(`/v1/connections/${connectionId}/lease`, {
  method: "POST",
  headers: { authorization: auth, "content-type": "application/json" },
  body: JSON.stringify({
    allowedActions: [`${service}.execute_read_query`],
    allowedResources: { schemas: [schema], tables: [`${schema}.${table}`] },
    invocationId,
    audience: principal.audience,
  }),
});
const leaseBody = (await leaseResponse.json()) as { token?: string };
const lease = requiredString(leaseBody.token, "lease token");
const url = new URL("http://oracle-mcp.test/v1/runtime/mcp/sse");
url.searchParams.set("connectionId", connectionId);
url.searchParams.set("invocationId", invocationId);
url.searchParams.set("audience", principal.audience);
const fetcher: typeof fetch = (input, init) => Promise.resolve(app.fetch(new Request(input, init)));
const transport = new StreamableHTTPClientTransport(url, {
  fetch: fetcher,
  requestInit: { headers: { "x-connection-lease": lease } },
});
const client = new Client({ name: "oracle-runtime-mcp", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const result = await client.callTool({
    name: "execute_action",
    arguments: {
      actionId: `${service}.execute_read_query`,
      input: {
        query: `select * from "${schema}"."${table}" where "ORDER_ID" = :p1`,
        parameters: ["O-2"],
        maxRows: 10,
      },
    },
  });
  const structured = result.structuredContent as {
    ok?: boolean;
    data?: { rows?: unknown[] };
    auditPersisted?: boolean;
  };
  const audit = await app.request(`/v1/audit?invocationId=${invocationId}`, { headers: { authorization: auth } });
  const auditBody = (await audit.json()) as { items?: Array<{ actionId?: string; ok?: boolean; caller?: string }> };
  const autoskillRoot = process.env.AUTOSKILL_ROOT ?? resolve(process.cwd(), "..", "autoskill-creator-baseline");
  const autoskill = await runAutoskill(
    join(autoskillRoot, "backend", ".venv", "bin", "python"),
    join(autoskillRoot, "backend"),
    {
      ...process.env,
      PYTHONPATH: join(autoskillRoot, "backend"),
      ORACLE_MCP_RUNTIME_URL: `http://127.0.0.1:${runtimePort}/v1/runtime/mcp/sse?connectionId=${encodeURIComponent(connectionId)}&invocationId=${encodeURIComponent(invocationId)}&audience=${encodeURIComponent(principal.audience)}`,
      ORACLE_MCP_LEASE: lease,
    },
  );
  const autoskillPassed = autoskill.status === 0 && autoskill.stdout.includes('"status": "passed"');
  const passed =
    tools.tools.some((tool) => tool.name === "execute_action") &&
    structured.ok === true &&
    structured.data?.rows?.length === 1 &&
    structured.auditPersisted === true &&
    autoskillPassed &&
    auditBody.items?.some(
      (item) => item.actionId === `${service}.execute_read_query` && item.ok === true && item.caller === "mcp",
    );
  const evidence = {
    service,
    protocolSteps: ["initialize", "tools/list", "tools/call"],
    tools: tools.tools.map((tool) => tool.name),
    queryResultRowCount: structured.data?.rows?.length ?? 0,
    auditPersisted: structured.auditPersisted === true,
    auditLineage:
      auditBody.items?.some((item) => item.actionId === `${service}.execute_read_query` && item.caller === "mcp") ===
      true,
    autoskill: autoskillPassed,
    passed,
  };
  console.log(JSON.stringify(evidence));
  if (!passed) process.exitCode = 1;
} finally {
  await client.close();
  await closeRuntimeServer(runtimeServer);
  await closeOraclePools();
  controlDatabase.close();
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} is missing.`);
  return value;
}

async function runAutoskill(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(executable, [resolvePath("scripts/verify-oracle-runtime-mcp-autoskill.py")], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.on("error", () => resolve({ status: null, stdout, stderr }));
  });
}

function resolvePath(path: string): string {
  return resolve(process.cwd(), path);
}

async function closeRuntimeServer(server: typeof runtimeServer): Promise<void> {
  const closable = server as typeof server & {
    closeAllConnections?: () => void;
    closeIdleConnections?: () => void;
  };
  closable.closeAllConnections?.();
  closable.closeIdleConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
