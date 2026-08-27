import type { ProviderDefinition } from "../src/core/types.ts";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { unlink } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCatalogStore } from "../src/catalog-store.ts";
import { createPrincipalToken } from "../src/control-plane/auth.ts";
import { TenantFileAdapter } from "../src/control-plane/file-adapter.ts";
import { ControlledMcpAdapter } from "../src/control-plane/mcp-adapter.ts";
import { RestOpenApiAdapter } from "../src/control-plane/rest-adapter.ts";
import { createConnectionControlApp } from "../src/control-plane/server.ts";
import { createGuardedFetch } from "../src/core/guarded-fetch.ts";
import { TransitFileService } from "../src/server/files/transit-files.ts";
import { AesGcmSecretCodec } from "../src/server/secrets/secret-codec.ts";

const evidenceDir = await mkdtemp(join(tmpdir(), "step2b-evidence-"));
const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  evidenceDir,
  checks: {},
};
const checks = results.checks as Record<string, unknown>;
const benchmark: Record<string, unknown> = {};
results.benchmark = benchmark;

const fixture = new Hono();
fixture.get("/records", (context) => context.json({ items: [{ id: "fixture-1" }] }));
fixture.post("/records", async (context) => context.json({ created: await context.req.json() }, 201));
const fixtureServer = serve({ fetch: fixture.fetch, hostname: "0.0.0.0", port: 0 });
const fixturePort = await new Promise<number>((resolve) =>
  fixtureServer.on("listening", () => resolve((fixtureServer.address() as { port: number }).port)),
);
try {
  const fixtureHost = process.env.STEP2B_FIXTURE_HOST ?? findFixtureHost();
  const fixtureUrl = `http://${fixtureHost}:${fixturePort}`;
  const fixtureFetcher = createGuardedFetch({ allowPrivateNetwork: true, lookup: null });
  const adapter = RestOpenApiAdapter.fromSpec(
    fixtureUrl,
    {
      info: { version: "fixture-1" },
      paths: {
        "/records": {
          get: { operationId: "listRecords", responses: { "200": {} } },
          post: { operationId: "createRecord", responses: { "201": {} } },
        },
      },
    },
    { type: "none" },
    true,
    fixtureFetcher,
  );
  const read = await adapter.invoke({ operationId: "listRecords" });
  const firstWrite = await adapter.invoke({
    operationId: "createRecord",
    body: { name: "e2e" },
    confirmed: true,
    idempotencyKey: "fixture-write-1",
  });
  const secondWrite = await adapter.invoke({
    operationId: "createRecord",
    body: { name: "e2e" },
    confirmed: true,
    idempotencyKey: "fixture-write-1",
  });
  checks.rest = {
    status: read.status === 200 && firstWrite.status === 201,
    idempotentReplay: JSON.stringify(firstWrite) === JSON.stringify(secondWrite),
    fixtureUrl,
  };
  const invocationRssBefore = process.memoryUsage().rss;
  const invocationLatencies = await Promise.all(
    Array.from({ length: 50 }, async (_, index) => {
      const startedAt = performance.now();
      const result = await adapter.invoke({ operationId: "listRecords", query: { sample: String(index) } });
      if (result.status !== 200) throw new Error(`Concurrent REST invocation ${index} failed.`);
      return performance.now() - startedAt;
    }),
  );
  benchmark.concurrentRestInvocations = {
    count: invocationLatencies.length,
    p95Ms: percentile(invocationLatencies, 95),
    p99Ms: percentile(invocationLatencies, 99),
    rssDeltaBytes: process.memoryUsage().rss - invocationRssBefore,
  };
} finally {
  fixtureServer.close();
}

const mcpPath = join(process.cwd(), "scripts", ".step2b-fixture-mcp.mjs");
await writeFile(
  mcpPath,
  `
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      let result = {};
      if (request.method === "initialize") {
        result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture-mcp", version: "1.0.0" } };
      } else if (request.method === "tools/list") {
        result = { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] };
      } else if (request.method === "tools/call") {
        result = { content: [{ type: "text", text: JSON.stringify(request.params.arguments ?? {}) }] };
      }
      if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    }
  });
`,
);
const mcp = new ControlledMcpAdapter({
  transport: "stdio",
  command: process.execPath,
  args: [mcpPath],
  allowedCommands: [process.execPath],
  allowedTools: ["echo"],
});
try {
  const discovered = await mcp.discover();
  const called = await mcp.callTool("echo", { value: "e2e" });
  checks.mcp = { status: discovered.tools.length === 1, toolCall: JSON.stringify(called).includes("e2e") };
} catch (error) {
  checks.mcp = { status: false, error: error instanceof Error ? error.message : String(error) };
}
await unlink(mcpPath).catch(() => undefined);

const fileRoot = join(evidenceDir, "files");
const transit = new TransitFileService({
  rootDir: fileRoot,
  publicOrigin: "http://127.0.0.1",
  ttlSeconds: 3600,
  maxBytes: 10 * 1024 * 1024,
});
const files = new TenantFileAdapter("tenant-a", "workspace-a", transit, new DatabaseSync(":memory:"));
const csv = await files.upload(new File(["a,b\n1,2\n"], "data.csv", { type: "text/csv" }));
const json = await files.upload(new File(['{"ok":true}'], "data.json", { type: "application/json" }));
const excelSource = "/Users/bytedance/DB-GPT/docker/examples/excel/example.xlsx";
const pdfSource = "/Users/bytedance/.openhands/cache/skills/public-skills/skills/theme-factory/theme-showcase.pdf";
const parquetSource = "/Users/bytedance/oracle_byaan_e2e/container_parquet/d_arc_brand.parquet";
const excelBytes = await readFile(excelSource);
const pdfBytes = await readFile(pdfSource);
const parquetBytes = await readFile(parquetSource);
const excel = await files.upload(
  new File([excelBytes], "data.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
);
const pdf = await files.upload(new File([pdfBytes], "data.pdf", { type: "application/pdf" }));
const parquet = await files.upload(new File([parquetBytes], "data.parquet"));
const [csvPreview, jsonPreview, excelPreview, pdfPreview, parquetPreview] = await Promise.all([
  files.preview(csv.fileId),
  files.preview(json.fileId),
  files.preview(excel.fileId),
  files.preview(pdf.fileId),
  files.preview(parquet.fileId),
]);
checks.files = {
  status:
    files.list().length === 5 &&
    csvPreview.kind === "csv" &&
    csvPreview.rows[0]?.[0] === "1" &&
    jsonPreview.kind === "json" &&
    excelPreview.kind === "excel" &&
    excelPreview.sheets.length > 0 &&
    pdfPreview.kind === "pdf" &&
    pdfPreview.text.length > 0 &&
    parquetPreview.kind === "parquet" &&
    parquetPreview.rows.length > 0,
  kinds: files.list().map((file) => file.kind),
  ids: [csv.fileId, json.fileId, pdf.fileId, excel.fileId, parquet.fileId],
  previews: {
    csv: csvPreview.kind === "csv" ? { columns: csvPreview.columns, rows: csvPreview.rows.length } : null,
    json: jsonPreview.kind === "json" ? { truncated: jsonPreview.truncated } : null,
    excel: excelPreview.kind === "excel" ? { sheets: excelPreview.sheets.length } : null,
    pdf: pdfPreview.kind === "pdf" ? { pages: pdfPreview.pageCount, textCharacters: pdfPreview.text.length } : null,
    parquet:
      parquetPreview.kind === "parquet"
        ? { columns: parquetPreview.columns, rows: parquetPreview.rows.length }
        : null,
  },
};

const provider: ProviderDefinition = {
  service: "fixture",
  displayName: "Fixture",
  categories: ["test"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [{ key: "secret", label: "Secret", inputType: "password", required: true, secret: true }],
    },
  ],
  actions: [],
};
const controlDb = new DatabaseSync(":memory:");
const controlApp = createConnectionControlApp({
  catalog: createCatalogStore([provider]),
  providerLoader: {
    loadActionExecutor: async () => undefined,
    loadProxyExecutor: async () => undefined,
    loadCredentialValidators: async () => undefined,
  },
  controlDatabase: controlDb,
  secretCodec: new AesGcmSecretCodec("e2e-encryption-key"),
  authSecret: "e2e-auth-secret",
  publicOrigin: "http://127.0.0.1",
  enablement: [{ service: "fixture", tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "e2e" }],
  fileStore: transit,
});
const tenant = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  subject: "user-a",
  ownerId: "user-a",
  audience: "runtime",
};
const token = createPrincipalToken(tenant, "e2e-auth-secret");
const created = await controlApp.request("/v1/connections", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ service: "fixture", authType: "custom_credential", values: { secret: "never-return-this" } }),
});
const createdBody = (await created.json()) as Record<string, unknown>;
const listed = await controlApp.request("/v1/connections", { headers: { authorization: `Bearer ${token}` } });
checks.controlPlane = {
  createStatus: created.status,
  listStatus: listed.status,
  credentialRedacted: !JSON.stringify(createdBody).includes("never-return-this"),
  ciphertextStored: Boolean(
    (
      controlDb.prepare("select credential_ciphertext from tenant_connections").get() as {
        credential_ciphertext?: string;
      }
    )?.credential_ciphertext?.startsWith("enc:v1:"),
  ),
};

const createLatencies: number[] = [];
for (let index = 1; index < 100; index += 1) {
  const startedAt = performance.now();
  const response = await controlApp.request("/v1/connections", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      service: "fixture",
      authType: "custom_credential",
      connectionName: `benchmark-${index}`,
      values: { secret: "benchmark-secret" },
    }),
  });
  if (response.status !== 201) throw new Error(`Connection benchmark create ${index} failed.`);
  createLatencies.push(performance.now() - startedAt);
}
const listStartedAt = performance.now();
const benchmarkList = await controlApp.request("/v1/connections", { headers: { authorization: `Bearer ${token}` } });
const benchmarkConnections = (await benchmarkList.json()) as { items: unknown[] };
benchmark.connectionCatalog = {
  count: benchmarkConnections.items.length,
  createP95Ms: percentile(createLatencies, 95),
  createP99Ms: percentile(createLatencies, 99),
  listMs: rounded(performance.now() - listStartedAt),
};

const largeFileBytes = new Uint8Array(10 * 1024 * 1024);
largeFileBytes.fill(0x61);
const fileRssBefore = process.memoryUsage().rss;
const largeFileStartedAt = performance.now();
const largeFile = await files.upload(new File([largeFileBytes], "ten-mib.txt", { type: "text/plain" }));
benchmark.largeFileUpload = {
  bytes: largeFile.sizeBytes,
  durationMs: rounded(performance.now() - largeFileStartedAt),
  rssDeltaBytes: process.memoryUsage().rss - fileRssBefore,
  storagePath: "transit file service",
  limitation: "TenantFileAdapter currently buffers bytes for scanning and hashing; this is not streaming-parser evidence.",
};

await writeFile(join(evidenceDir, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return rounded(sorted[Math.max(0, index)] ?? 0);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function findFixtureHost(): string {
  const candidates = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  const host = candidates.find((address) => address.startsWith("192.168.")) ?? candidates[0];
  if (!host) {
    throw new Error("No non-loopback IPv4 address is available for the TCP fixture.");
  }
  return host;
}
