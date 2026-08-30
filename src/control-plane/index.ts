import type { ResolvedCredential } from "../core/types.ts";
import type { EnablementEntry } from "./catalog.ts";

import { serve } from "@hono/node-server";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadCatalog } from "../catalog-store.ts";
import { parsePrivateNetworkAccessFlag, setPrivateNetworkAccessAllowed } from "../core/request.ts";
import { closeOraclePools } from "../providers/oracle_database/runtime.ts";
import { ProviderLoader } from "../providers/provider-loader.ts";
import { executorModules } from "../providers/registry.generated.ts";
import { withNodeStagedFile } from "../server/files/node-transit-file-upload.ts";
import { TransitFileService } from "../server/files/transit-files.ts";
import { createSecretCodec } from "../server/secrets/secret-codec.ts";
import { OracleThinDriver } from "./oracle-driver.ts";
import { createConnectionControlApp } from "./server.ts";
import { runWebDiscoveryCapture } from "./web-discovery-worker.ts";

const port = positiveInteger(process.env.CONNECTION_SERVICE_PORT, 3400);
const host = process.env.CONNECTION_SERVICE_HOST ?? "127.0.0.1";
const dataDir = process.env.CONNECTION_SERVICE_DATA_DIR ?? join(process.cwd(), "data", "connection-service");
const authSecret = requiredEnv("CONNECTION_SERVICE_AUTH_SECRET");
const encryptionKey = requiredEnv("CONNECTION_SERVICE_ENCRYPTION_KEY");
const enablement = readEnablement(process.env.CONNECTION_SERVICE_ENABLEMENT_JSON);
setPrivateNetworkAccessAllowed(parsePrivateNetworkAccessFlag(process.env.OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK));
const webEgress = readWebEgress();

await mkdir(dataDir, { recursive: true });
const catalog = await loadCatalog(undefined, { executableServices: Object.keys(executorModules) });
const database = new DatabaseSync(join(dataDir, "control.sqlite"));
const transitFiles = new TransitFileService({
  rootDir: join(dataDir, "transit-files"),
  publicOrigin: process.env.CONNECTION_SERVICE_PUBLIC_ORIGIN ?? `http://${host}:${port}`,
  ttlSeconds: positiveInteger(process.env.CONNECTION_SERVICE_TRANSIT_TTL_SECONDS, 86_400),
  maxBytes: positiveInteger(process.env.CONNECTION_SERVICE_TRANSIT_MAX_BYTES, 100 * 1024 * 1024),
});
const transitFileTempDir = join(dataDir, "upload-staging");
const app = createConnectionControlApp({
  catalog,
  providerLoader: new ProviderLoader(executorModules),
  controlDatabase: database,
  secretCodec: createSecretCodec(encryptionKey),
  authSecret,
  publicOrigin: process.env.CONNECTION_SERVICE_PUBLIC_ORIGIN ?? `http://${host}:${port}`,
  enablement,
  webEgress,
  transitFiles,
  fileStore: transitFiles,
  stageFileUpload: (request, consume) =>
    withNodeStagedFile(request, { tempDir: transitFileTempDir, maxBytes: transitFiles.maxBytes }, consume),
  oracleDriverFactory: (config, credentials) => new OracleThinDriver(config, credentials),
  captureWebDiscovery: async (input) =>
    captureWithCredential({
      input,
      run: runWebDiscoveryCapture,
    }),
});

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(
    JSON.stringify({
      service: "connection-service",
      url: `http://${info.address}:${info.port}`,
      catalogProviderCount: catalog.providers.length,
      catalogActionCount: catalog.actions.length,
      enabledServices: enablement.map((entry) => entry.service),
    }),
  );
});
let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  await closeOraclePools();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readWebEgress() {
  if (process.env.CONNECTION_SERVICE_WEB_ALLOW_LOCALHOST_DEV !== "true") return undefined;
  const ports = (process.env.CONNECTION_SERVICE_WEB_LOCALHOST_PORTS ?? "")
    .split(",")
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return { allowLocalhostDev: true, allowedLocalhostPorts: ports };
}

async function captureWithCredential(input: {
  input: Parameters<NonNullable<Parameters<typeof createConnectionControlApp>[0]["captureWebDiscovery"]>>[0];
  run: typeof runWebDiscoveryCapture;
}) {
  const result = await input.run({
    pageUrl: input.input.pageUrl,
    approvedOrigin: input.input.approvedOrigin,
    executablePath: process.env.WEB_DISCOVERY_CHROME_PATH,
    storageStatePath: process.env.WEB_DISCOVERY_STORAGE_STATE_PATH,
    ignoreHTTPSErrors: process.env.WEB_DISCOVERY_IGNORE_HTTPS_ERRORS === "true",
    durationMs: positiveInteger(process.env.WEB_DISCOVERY_DURATION_MS, 1_000),
    submitObservation: input.input.submitObservation,
    interactAfterNavigate:
      process.env.WEB_DISCOVERY_INTERACTION === "w3-fixture"
        ? async (page) => {
            await page.getByTestId("username").fill("fixture-user");
            await page.getByTestId("password").fill("fixture-password");
            await page.getByRole("button", { name: "Log in" }).click();
            await page.getByTestId("dashboard").waitFor();
            await page.getByRole("button", { name: "Load items" }).click();
            await page.getByRole("button", { name: "Load detail" }).click();
            await page.getByRole("button", { name: "Approve item" }).click();
          }
        : undefined,
    onAuthenticatedCookies: async (cookies) => {
      const host = new URL(input.input.approvedOrigin).hostname;
      const sameOriginCookies = cookies.filter(
        (cookie) => cookie.domain.replace(/^\./, "").toLowerCase() === host.toLowerCase(),
      );
      const secret = sameOriginCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      if (!secret) return;
      const credential: ResolvedCredential = {
        authType: "custom_credential",
        values: { cookie: secret },
        profile: { accountId: host, displayName: host, grantedScopes: [] },
        metadata: {},
      };
      await input.input.saveCredential(credential);
    },
  });
  return result;
}

function readEnablement(value: string | undefined): EnablementEntry[] {
  if (!value) {
    return [
      {
        service: "hackernews",
        tier: "catalog",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/knowledge-workspace/evidence/step2-existing-replay-final.json",
      },
      {
        service: "postgresql",
        tier: "verified",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/connection-expansion/evidence/postgresql-real-engine.json",
      },
      {
        service: "mysql",
        tier: "verified",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/connection-expansion/evidence/mysql-real-engine.json",
      },
      {
        service: "oracle_database",
        tier: "verified",
        connectorDefinitionVersion: "1.0.0",
        owner: "connection-service",
        evidenceRef: "docs/connection-expansion/evidence/oracle-database-real-engine.json",
      },
      {
        service: "sql_server",
        tier: "beta",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/connection-expansion/evidence/sql-server-external-blocker.json",
      },
      {
        service: "clickhouse",
        tier: "verified",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/connection-expansion/evidence/clickhouse-real-engine.json",
      },
      {
        service: "doris",
        tier: "verified",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/connection-expansion/evidence/doris-real-engine.json",
      },
      {
        service: "starrocks",
        tier: "verified",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/connection-expansion/evidence/starrocks-real-engine.json",
      },
      {
        service: "feishu",
        tier: "beta",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/connection-expansion/w2-office-storage-handoff.json#/connections/0",
      },
      {
        service: "dingtalk",
        tier: "beta",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/connection-expansion/w2-office-storage-handoff.json#/connections/1",
      },
      {
        service: "wecom",
        tier: "beta",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/connection-expansion/w2-office-storage-handoff.json#/connections/2",
      },
      {
        service: "aws_s3",
        tier: "beta",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/connection-expansion/w2-office-storage-handoff.json#/connections/3",
      },
      {
        service: "aliyun_oss",
        tier: "beta",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/connection-expansion/w2-office-storage-handoff.json#/connections/4",
      },
      {
        service: "volcengine_tos",
        tier: "beta",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
        evidenceRef: "docs/connection-expansion/w2-office-storage-handoff.json#/connections/5",
      },
    ];
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("CONNECTION_SERVICE_ENABLEMENT_JSON must be a JSON array.");
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Invalid connector enablement entry.");
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.service !== "string" ||
      !["catalog", "beta", "verified"].includes(String(candidate.tier)) ||
      typeof candidate.connectorDefinitionVersion !== "string" ||
      typeof candidate.owner !== "string" ||
      typeof candidate.evidenceRef !== "string" ||
      candidate.evidenceRef.trim() === ""
    ) {
      throw new Error("Enablement entries require service, tier, connectorDefinitionVersion, owner, and evidenceRef.");
    }
    return {
      service: candidate.service,
      tier: candidate.tier as EnablementEntry["tier"],
      connectorDefinitionVersion: candidate.connectorDefinitionVersion,
      owner: candidate.owner,
      evidenceRef: candidate.evidenceRef,
    };
  });
}
