import type { EnablementEntry } from "./catalog.ts";

import { serve } from "@hono/node-server";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadCatalog } from "../catalog-store.ts";
import { parsePrivateNetworkAccessFlag, setPrivateNetworkAccessAllowed } from "../core/request.ts";
import { HttpCredentialBroker } from "../identity/credential-broker.ts";
import { createOAuthIntrospectionVerifier } from "../identity/oauth-introspection-verifier.ts";
import { createOAuthJwtVerifier } from "../identity/oauth-jwt-verifier.ts";
import { createTipVerifier } from "../identity/tip-verifier.ts";
import { ProviderLoader } from "../providers/provider-loader.ts";
import { executorModules } from "../providers/registry.generated.ts";
import { withNodeStagedFile } from "../server/files/node-transit-file-upload.ts";
import { TransitFileService } from "../server/files/transit-files.ts";
import { createSecretCodec } from "../server/secrets/secret-codec.ts";
import { VolcApplicationCenterRegistry } from "./application-center-client.ts";
import { OracleThinDriver } from "./oracle-driver.ts";
import { createConnectionControlApp } from "./server.ts";

const port = positiveInteger(process.env.CONNECTION_SERVICE_PORT, 3400);
const host = process.env.CONNECTION_SERVICE_HOST ?? "127.0.0.1";
const dataDir = process.env.CONNECTION_SERVICE_DATA_DIR ?? join(process.cwd(), "data", "connection-service");
const authSecret = requiredEnv("CONNECTION_SERVICE_AUTH_SECRET");
const encryptionKey = requiredEnv("CONNECTION_SERVICE_ENCRYPTION_KEY");
const enablement = readEnablement(process.env.CONNECTION_SERVICE_ENABLEMENT_JSON);
const arkclaw = createArkClawOptions();
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
  arkclaw,
  applicationCenter: createApplicationCenterOptions(),
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
        tier: "beta",
        connectorDefinitionVersion: "1.0.0",
        owner: "connection-service",
        evidenceRef: "docs/connection-expansion/evidence/oracle-database-real-engine.json",
        verificationReason:
          "Canonical Oracle real-engine coverage is recorded, but end-to-end AutoSkill MCP evidence is still blocked by the missing local baseline checkout.",
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

function createArkClawOptions() {
  const hashes = (process.env.ARKCLAW_MCP_API_KEY_HASHES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const issuers = (process.env.ARKCLAW_TIP_ALLOWED_ISSUERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const audience = process.env.ARKCLAW_TIP_AUDIENCE?.trim();
  if (hashes.length === 0 && issuers.length === 0 && !audience) return undefined;
  if (hashes.length === 0 || issuers.length === 0 || !audience) {
    throw new Error(
      "ARKCLAW_MCP_API_KEY_HASHES, ARKCLAW_TIP_ALLOWED_ISSUERS, and ARKCLAW_TIP_AUDIENCE must be configured together.",
    );
  }
  return {
    apiKeyHashes: hashes,
    verifyTip: createTipVerifier({ allowedIssuers: issuers, audience }),
    credentialBroker: createCredentialBroker(),
    verifyOAuthToken: createArkClawOAuthVerifier(),
  };
}

function createArkClawOAuthVerifier() {
  const introspectionEndpoint = process.env.ARKCLAW_OAUTH_INTROSPECTION_ENDPOINT?.trim();
  const introspectionClientId = process.env.ARKCLAW_OAUTH_INTROSPECTION_CLIENT_ID?.trim();
  const introspectionClientSecret = process.env.ARKCLAW_OAUTH_INTROSPECTION_CLIENT_SECRET;
  const jwksUri = process.env.ARKCLAW_OAUTH_JWKS_URI?.trim();
  const issuer = process.env.ARKCLAW_OAUTH_ISSUER?.trim();
  const audience = process.env.ARKCLAW_OAUTH_AUDIENCE?.trim();
  const hasJwt = Boolean(jwksUri);
  const hasIntrospection = Boolean(introspectionEndpoint || introspectionClientId || introspectionClientSecret);
  if (!hasJwt && !hasIntrospection && !issuer && !audience) return undefined;
  if (!issuer || !audience || hasJwt === hasIntrospection) {
    throw new Error(
      "Configure ARKCLAW_OAUTH_ISSUER and ARKCLAW_OAUTH_AUDIENCE with exactly one of JWKS URI or introspection.",
    );
  }
  if (jwksUri) return createOAuthJwtVerifier({ jwksUri, issuer, audience });
  if (!introspectionEndpoint || !introspectionClientId || !introspectionClientSecret) {
    throw new Error("OAuth introspection endpoint, client ID, and client secret must be configured together.");
  }
  return createOAuthIntrospectionVerifier({
    endpoint: introspectionEndpoint,
    clientId: introspectionClientId,
    clientSecret: introspectionClientSecret,
    issuer,
    audience,
  });
}

function createCredentialBroker() {
  const endpoint = process.env.ARKCLAW_CREDENTIAL_BROKER_URL?.trim();
  const token = process.env.ARKCLAW_CREDENTIAL_BROKER_TOKEN?.trim();
  if (!endpoint && !token) return undefined;
  if (!endpoint || !token) {
    throw new Error("ARKCLAW_CREDENTIAL_BROKER_URL and ARKCLAW_CREDENTIAL_BROKER_TOKEN must be configured together.");
  }
  return new HttpCredentialBroker(new URL(endpoint), token);
}

function createApplicationCenterOptions() {
  const endpoint = process.env.APPLICATION_CENTER_ENDPOINT?.trim();
  const ak = process.env.APPLICATION_CENTER_ACCESS_KEY_ID?.trim();
  const sk = process.env.APPLICATION_CENTER_SECRET_ACCESS_KEY;
  const spaceId = process.env.APPLICATION_CENTER_SPACE_ID?.trim();
  const clawId = process.env.APPLICATION_CENTER_CLAW_ID?.trim();
  const resourceMode: "enterprise" | "user" =
    process.env.APPLICATION_CENTER_RESOURCE_MODE?.trim() === "user" ? "user" : "enterprise";
  if (!endpoint && !ak && !sk && !spaceId && !clawId) return undefined;
  if (!endpoint || !ak || !sk || !spaceId) {
    throw new Error(
      "APPLICATION_CENTER_ENDPOINT, APPLICATION_CENTER_ACCESS_KEY_ID, APPLICATION_CENTER_SECRET_ACCESS_KEY, and APPLICATION_CENTER_SPACE_ID must be configured together.",
    );
  }
  if (resourceMode !== "enterprise" && resourceMode !== "user") {
    throw new Error("APPLICATION_CENTER_RESOURCE_MODE must be enterprise or user.");
  }
  if (resourceMode === "user" && !clawId) {
    throw new Error("APPLICATION_CENTER_CLAW_ID is required in user resource mode.");
  }
  const userPoolUserUid = process.env.APPLICATION_CENTER_USER_POOL_USER_UID?.trim();
  if (resourceMode === "user" && !userPoolUserUid) {
    throw new Error("APPLICATION_CENTER_USER_POOL_USER_UID is required in user resource mode.");
  }
  const region = process.env.APPLICATION_CENTER_REGION?.trim() || "cn-beijing";
  const accountId = Number(process.env.APPLICATION_CENTER_TOP_ACCOUNT_ID);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error("APPLICATION_CENTER_TOP_ACCOUNT_ID must be a positive integer.");
  }
  const registry = new VolcApplicationCenterRegistry({
    endpoint: new URL(endpoint),
    region,
    accessKeyId: ak,
    secretAccessKey: sk,
    service: process.env.APPLICATION_CENTER_SERVICE?.trim() || "ai_registry",
    top: {
      accountId,
      region,
      sourceService: process.env.APPLICATION_CENTER_TOP_SOURCE_SERVICE?.trim() || "open-connector",
      destService: process.env.APPLICATION_CENTER_TOP_DEST_SERVICE?.trim() || "ai_registry",
      userId: process.env.APPLICATION_CENTER_TOP_USER_ID
        ? Number(process.env.APPLICATION_CENTER_TOP_USER_ID)
        : undefined,
      roleId: process.env.APPLICATION_CENTER_TOP_ROLE_ID
        ? Number(process.env.APPLICATION_CENTER_TOP_ROLE_ID)
        : undefined,
      isInternal: process.env.APPLICATION_CENTER_TOP_IS_INTERNAL
        ? Number(process.env.APPLICATION_CENTER_TOP_IS_INTERNAL)
        : undefined,
      psm: process.env.APPLICATION_CENTER_TOP_PSM?.trim() || undefined,
      site: process.env.APPLICATION_CENTER_TOP_SITE?.trim() || undefined,
    },
  });
  return {
    registry,
    spaceId,
    resourceMode,
    ...(clawId ? { clawId } : {}),
    userPoolUserUid,
    allowRawCredentialProvisioning: process.env.APPLICATION_CENTER_ALLOW_RAW_CREDENTIAL_PROVISIONING === "true",
  };
}
