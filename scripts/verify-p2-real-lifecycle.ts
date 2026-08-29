import type { ResolvedCredential } from "../src/core/types.ts";

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadCatalog } from "../src/catalog-store.ts";
import { createPrincipalToken } from "../src/control-plane/auth.ts";
import { createConnectionControlApp } from "../src/control-plane/server.ts";
import { createTenantRuntime } from "../src/control-plane/service.ts";
import { ProviderLoader } from "../src/providers/provider-loader.ts";
import { executorModules } from "../src/providers/registry.generated.ts";
import { TransitFileService } from "../src/server/files/transit-files.ts";
import { AesGcmSecretCodec } from "../src/server/secrets/secret-codec.ts";

const services = ["tencent_docs", "wps_mcp", "baidu_netdisk", "tencent_cos", "huawei_obs", "minio", "qiniu_kodo"];
const oauthServices = new Set(["tencent_docs", "baidu_netdisk"]);
const apiKeyServices = new Set(["wps_mcp"]);
const outputPath = process.env.P2_LIFECYCLE_EVIDENCE_PATH;
const root = join(tmpdir(), `p2-real-lifecycle-${process.pid}`);
const results: Array<Record<string, unknown>> = [];

await mkdir(root, { recursive: true });
try {
  for (const service of services) {
    const prefix = `P2_${service.toUpperCase()}_`;
    const credentialJson = process.env[`${prefix}CREDENTIAL_JSON`];
    const readAction = process.env[`${prefix}READ_ACTION`];
    const readInputJson = process.env[`${prefix}READ_INPUT_JSON`];
    if (!credentialJson || !readAction || !readInputJson) {
      results.push({
        providerId: service,
        status: "BLOCKED",
        missingGates: [
          ...(!credentialJson ? [`${prefix}CREDENTIAL_JSON`] : []),
          ...(!readAction ? [`${prefix}READ_ACTION`] : []),
          ...(!readInputJson ? [`${prefix}READ_INPUT_JSON`] : []),
        ],
        reason: "Real provider credentials and a known bounded-read target were not supplied.",
      });
      continue;
    }

    results.push(await runLifecycle(service, parseRecord(credentialJson), readAction, parseRecord(readInputJson)));
  }

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: results.every((result) => result.status === "PASS") ? "PASS" : "BLOCKED",
    note: "BLOCKED is expected when real provider credentials or known read targets are unavailable. Contract fixtures never promote a provider to verified.",
    providers: results,
  };
  const serialized = JSON.stringify(evidence, null, 2);
  if (outputPath) {
    await mkdir(join(process.cwd(), outputPath, ".."), { recursive: true });
    await writeFile(outputPath, `${serialized}\n`);
  }
  console.log(serialized);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runLifecycle(
  service: string,
  credentialInput: Record<string, unknown>,
  readAction: string,
  readInput: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const database = new DatabaseSync(":memory:");
  const secretCodec = new AesGcmSecretCodec(`p2-real-lifecycle-${service}`);
  const catalog = await loadCatalog(undefined, { executableServices: Object.keys(executorModules) });
  const provider = catalog.providers.find((entry) => entry.service === service);
  if (!provider) throw new Error(`Unknown P2 provider: ${service}`);
  if (!provider.actions.some((action) => action.id === `${service}.${readAction}`)) {
    throw new Error(`${service}.${readAction} is not a declared action.`);
  }
  const loader = new ProviderLoader({ [service]: executorModules[service]! });
  const primary = {
    tenantId: "p2-real-tenant",
    workspaceId: "p2-real-workspace",
    subject: "p2-real-user",
    ownerId: "p2-real-user",
    audience: "p2-real-lifecycle",
  };
  const other = {
    ...primary,
    tenantId: "p2-other-tenant",
    workspaceId: "p2-other-workspace",
    subject: "p2-other-user",
    ownerId: "p2-other-user",
  };
  const authSecret = `p2-real-auth-${service}`;
  const auth = createPrincipalToken(primary, authSecret);
  const otherAuth = createPrincipalToken(other, authSecret);
  const transitFiles = new TransitFileService({
    rootDir: join(root, service),
    publicOrigin: "http://connection-service.test",
    ttlSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
  });
  const app = createConnectionControlApp({
    catalog,
    providerLoader: loader,
    controlDatabase: database,
    secretCodec,
    authSecret,
    publicOrigin: "http://connection-service.test",
    enablement: [
      {
        service,
        tier: "beta",
        connectorDefinitionVersion: "1.0.0",
        owner: "connection-expansion-p2",
        evidenceRef: "credential-gated-runtime",
      },
    ],
    transitFiles,
    fileStore: transitFiles,
  });

  try {
    let connectionId: string;
    if (oauthServices.has(service)) {
      const runtime = createTenantRuntime(
        {
          catalog,
          providerLoader: loader,
          controlDatabase: database,
          secretCodec,
          publicOrigin: "http://connection-service.test",
          transitFiles,
        },
        primary,
      );
      const summary = await runtime.connectionService.setOAuthCredential(
        service,
        toOAuthCredential(credentialInput),
        "p2-real",
      );
      connectionId = summary.id;
    } else {
      const authType = apiKeyServices.has(service) ? "api_key" : "custom_credential";
      const created = await request(app, "/v1/connections", auth, {
        service,
        authType,
        connectionName: "p2-real",
        values: credentialInput,
      });
      await expectStatus(created, 201, `${service} create`);
      connectionId = requiredPath(await created.json(), "connection", "id");
    }

    const stored = database
      .prepare("select credential_ciphertext from tenant_connections where id=?")
      .get(connectionId) as { credential_ciphertext: string };
    const encryptedAtRest = stored.credential_ciphertext.startsWith("enc:v1:");
    const otherConnections = await app.request("/v1/connections", {
      headers: { authorization: `Bearer ${otherAuth}` },
    });
    const tenantIsolated = JSON.stringify(await otherConnections.json()) === '{"items":[]}';

    const validation = await request(app, `/v1/connections/${connectionId}/validate`, auth, {});
    await expectStatus(validation, 202, `${service} validate`);
    const validated = requiredPath(await validation.json(), "job", "status") === "succeeded";

    const discoveryLease = await issueLease(app, auth, connectionId, [`${service}.discover_resources`], "discover");
    const discovery = await app.request(`/v1/connections/${connectionId}/discover`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth}`,
        "x-connection-lease": discoveryLease,
        "x-connection-invocation-id": "discover",
        "x-connection-audience": primary.audience,
      },
    });
    await expectStatus(discovery, 202, `${service} discover`);
    const discoverySucceeded = requiredPath(await discovery.json(), "job", "status") === "succeeded";

    const actionId = `${service}.${readAction}`;
    const actionLease = await issueLease(app, auth, connectionId, [actionId], "read");
    const read = await request(
      app,
      `/v1/runtime/actions/${actionId}`,
      auth,
      {
        connectionId,
        invocationId: "read",
        audience: primary.audience,
        input: readInput,
      },
      actionLease,
    );
    await expectStatus(read, 200, `${service} bounded read`);
    const readBody = (await read.json()) as Record<string, unknown>;
    const boundedRead = readBody.ok === true && readBody.auditPersisted === true;
    const audit = await app.request("/v1/audit", { headers: { authorization: `Bearer ${auth}` } });
    const auditPersisted = JSON.stringify(await audit.json()).includes(actionId);

    const deleted = await app.request(`/v1/connections/${connectionId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${auth}` },
    });
    await expectStatus(deleted, 204, `${service} delete`);
    const afterDelete = await request(
      app,
      `/v1/runtime/actions/${actionId}`,
      auth,
      {
        connectionId,
        invocationId: "read",
        audience: primary.audience,
        input: readInput,
      },
      actionLease,
    );
    const revoked = afterDelete.status === 404 || afterDelete.status === 401;

    const checks = {
      configured: true,
      encryptedAtRest,
      tenantIsolated,
      validated,
      discoverySucceeded,
      boundedRead,
      auditPersisted,
      revoked,
    };
    if (Object.values(checks).some((value) => value !== true)) {
      throw new Error(`${service} lifecycle checks did not all pass.`);
    }
    return { providerId: service, status: "PASS", checks };
  } catch (error) {
    return {
      providerId: service,
      status: "FAIL",
      error: error instanceof Error ? error.message : "Lifecycle verification failed.",
    };
  } finally {
    database.close();
  }
}

function toOAuthCredential(input: Record<string, unknown>): Extract<ResolvedCredential, { authType: "oauth2" }> {
  const accessToken = requiredString(input.accessToken, "accessToken");
  const accountId = optionalString(input.accountId) ?? "credential-gated-account";
  return {
    authType: "oauth2",
    accessToken,
    refreshToken: optionalString(input.refreshToken),
    expiresAt: optionalString(input.expiresAt),
    tokenType: optionalString(input.tokenType) ?? "Bearer",
    profile: {
      accountId,
      displayName: optionalString(input.displayName) ?? accountId,
      grantedScopes: Array.isArray(input.grantedScopes) ? input.grantedScopes.map(String) : [],
    },
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata as Record<string, unknown>
      : {},
  };
}

async function issueLease(
  app: ReturnType<typeof createConnectionControlApp>,
  auth: string,
  connectionId: string,
  allowedActions: string[],
  invocationId: string,
): Promise<string> {
  const response = await request(app, `/v1/connections/${connectionId}/lease`, auth, {
    allowedActions,
    invocationId,
    audience: "p2-real-lifecycle",
    ttlSeconds: 300,
  });
  await expectStatus(response, 201, "lease");
  return requiredPath(await response.json(), "token");
}

async function request(
  app: ReturnType<typeof createConnectionControlApp>,
  path: string,
  auth: string,
  body: Record<string, unknown>,
  lease?: string,
): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth}`,
      "content-type": "application/json",
      ...(lease ? { "x-connection-lease": lease } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function expectStatus(response: Response, status: number, phase: string): Promise<void> {
  if (response.status !== status) {
    throw new Error(`${phase} returned ${response.status}: ${JSON.stringify(await response.json())}`);
  }
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Credential and input gates must contain JSON objects.");
  }
  return parsed as Record<string, unknown>;
}

function requiredPath(value: unknown, ...path: string[]): string {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error(`Missing ${path.join(".")}`);
    current = (current as Record<string, unknown>)[key];
  }
  return requiredString(current, path.join("."));
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
