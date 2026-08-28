import type { EnablementEntry } from "./catalog.ts";

import { serve } from "@hono/node-server";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadCatalog } from "../catalog-store.ts";
import { parsePrivateNetworkAccessFlag, setPrivateNetworkAccessAllowed } from "../core/request.ts";
import { ProviderLoader } from "../providers/provider-loader.ts";
import { executorModules } from "../providers/registry.generated.ts";
import { withNodeStagedFile } from "../server/files/node-transit-file-upload.ts";
import { TransitFileService } from "../server/files/transit-files.ts";
import { createSecretCodec } from "../server/secrets/secret-codec.ts";
import { OracleThinDriver } from "./oracle-driver.ts";
import { createConnectionControlApp } from "./server.ts";

const port = positiveInteger(process.env.CONNECTION_SERVICE_PORT, 3400);
const host = process.env.CONNECTION_SERVICE_HOST ?? "127.0.0.1";
const dataDir = process.env.CONNECTION_SERVICE_DATA_DIR ?? join(process.cwd(), "data", "connection-service");
const authSecret = requiredEnv("CONNECTION_SERVICE_AUTH_SECRET");
const encryptionKey = requiredEnv("CONNECTION_SERVICE_ENCRYPTION_KEY");
const enablement = readEnablement(process.env.CONNECTION_SERVICE_ENABLEMENT_JSON);
setPrivateNetworkAccessAllowed(parsePrivateNetworkAccessFlag(process.env.OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK));

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
  transitFiles,
  fileStore: transitFiles,
  stageFileUpload: (request, consume) =>
    withNodeStagedFile(request, { tempDir: transitFileTempDir, maxBytes: transitFiles.maxBytes }, consume),
  oracleDriverFactory: (config, credentials) => new OracleThinDriver(config, credentials),
});

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
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

function readEnablement(value: string | undefined): EnablementEntry[] {
  if (!value) {
    return [
      {
        service: "feishu",
        tier: "beta",
        connectorDefinitionVersion: "1.0.0",
        owner: "knowledge-platform",
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
      typeof candidate.owner !== "string"
    ) {
      throw new Error("Enablement entries require service, tier, connectorDefinitionVersion, and owner.");
    }
    return {
      service: candidate.service,
      tier: candidate.tier as EnablementEntry["tier"],
      connectorDefinitionVersion: candidate.connectorDefinitionVersion,
      owner: candidate.owner,
      evidenceRef: typeof candidate.evidenceRef === "string" ? candidate.evidenceRef : undefined,
    };
  });
}
