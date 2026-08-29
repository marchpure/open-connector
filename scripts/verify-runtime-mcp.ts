import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createPrincipalToken } from "../src/control-plane/auth.ts";

const port = 34_271;
const origin = `http://127.0.0.1:${port}`;
const invocationId = `runtime-mcp-smoke-${Date.now()}`;
const principal = {
  tenantId: "runtime-mcp-smoke",
  workspaceId: "runtime-mcp-smoke",
  subject: "runtime-mcp-smoke",
  ownerId: "runtime-mcp-smoke",
  audience: "knowledge-runtime",
};
const authSecret = "runtime-mcp-smoke-auth";
const dataDir = await mkdtemp(join(tmpdir(), "connection-runtime-mcp-"));
const server = spawn(process.execPath, ["src/control-plane/index.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CONNECTION_SERVICE_PORT: String(port),
    CONNECTION_SERVICE_DATA_DIR: dataDir,
    CONNECTION_SERVICE_AUTH_SECRET: authSecret,
    CONNECTION_SERVICE_ENCRYPTION_KEY: "runtime-mcp-smoke-encryption",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += String(chunk);
});
server.stderr.on("data", (chunk) => {
  serverOutput += String(chunk);
});

try {
  await waitForHealth();
  const authorization = `Bearer ${createPrincipalToken(principal, authSecret)}`;
  const created = await requestJson<{ connection: { id: string } }>("/v1/connections", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      service: "hackernews",
      authType: "no_auth",
      connectionName: "runtime-mcp-smoke",
    }),
  });
  const lease = await requestJson<{ token: string }>(`/v1/connections/${created.connection.id}/lease`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      allowedActions: ["hackernews.get_max_item_id"],
      invocationId,
      audience: principal.audience,
    }),
  });
  const runtimeUrl = new URL(`${origin}/v1/runtime/mcp/sse`);
  runtimeUrl.searchParams.set("connectionId", created.connection.id);
  runtimeUrl.searchParams.set("invocationId", invocationId);
  runtimeUrl.searchParams.set("audience", principal.audience);
  const transport = new StreamableHTTPClientTransport(runtimeUrl, {
    requestInit: {
      headers: {
        "x-connection-lease": lease.token,
      },
    },
  });
  const client = new Client({ name: "runtime-mcp-real-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const result = await client.callTool({
      name: "execute_action",
      arguments: { actionId: "hackernews.get_max_item_id", input: {} },
    });
    if (result.isError) throw new Error(`Real provider call failed: ${JSON.stringify(result)}`);
    const autoskillRoot = process.env.AUTOSKILL_ROOT ?? resolve(process.cwd(), "..", "autoskill-creator-baseline");
    const python = join(autoskillRoot, "backend", ".venv", "bin", "python");
    const autoskillSmoke = spawnSync(python, [resolve("scripts/verify-runtime-mcp-autoskill.py")], {
      cwd: join(autoskillRoot, "backend"),
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONPATH: join(autoskillRoot, "backend"),
        CONNECTION_RUNTIME_MCP_URL: runtimeUrl.toString(),
        CONNECTION_RUNTIME_MCP_LEASE: lease.token,
      },
    });
    if (autoskillSmoke.status !== 0) {
      throw new Error(`AutoSkill Python MCP smoke failed:\n${autoskillSmoke.stdout}\n${autoskillSmoke.stderr}`);
    }
    const autoskillResult = JSON.parse(autoskillSmoke.stdout.trim()) as { status?: string; client?: string };
    if (autoskillResult.status !== "passed") {
      throw new Error(`AutoSkill Python MCP smoke did not pass: ${autoskillSmoke.stdout}`);
    }
    const audit = await requestJson<{ items: Array<{ invocationId?: string; actionId: string; ok: boolean }> }>(
      `/v1/audit?invocationId=${encodeURIComponent(invocationId)}`,
      { headers: { authorization } },
    );
    if (
      !audit.items.some(
        (item) => item.invocationId === invocationId && item.actionId === "hackernews.get_max_item_id" && item.ok,
      )
    ) {
      throw new Error("Successful invocation audit was not persisted.");
    }
    console.log(
      JSON.stringify({
        status: "passed",
        endpoint: runtimeUrl.toString(),
        protocol: "streamable-http",
        autoskillClient: autoskillResult.client,
        tools: tools.tools.map((tool) => tool.name),
        actionId: "hackernews.get_max_item_id",
        invocationId,
        auditPersisted: true,
      }),
    );
  } finally {
    await client.close();
  }
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.stack : String(error)}\nConnection Service output:\n${serverOutput}`,
  );
} finally {
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once("exit", () => resolve());
    setTimeout(() => {
      server.kill("SIGKILL");
      resolve();
    }, 2_000).unref();
  });
  await rm(dataDir, { recursive: true, force: true });
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Connection Service exited before startup:\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Connection Service did not become healthy:\n${serverOutput}`);
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${origin}${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(body)}`);
  return body as T;
}
