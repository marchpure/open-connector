import type { ProviderDefinition } from "../src/core/types.ts";

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { createCatalogStore } from "../src/catalog-store.ts";
import { createPrincipalToken } from "../src/control-plane/auth.ts";
import { createConnectionControlApp } from "../src/control-plane/server.ts";
import { setPrivateNetworkAccessAllowed } from "../src/core/request.ts";
import { ProviderLoader } from "../src/providers/provider-loader.ts";
import { AesGcmSecretCodec } from "../src/server/secrets/secret-codec.ts";

const service = requiredEnv("DATABASE_PROVIDER");
const credentials = JSON.parse(requiredEnv("DATABASE_CREDENTIALS_JSON")) as Record<string, string>;
const image = process.env.DATABASE_IMAGE ?? "external";
const table = process.env.DATABASE_TEST_TABLE ?? "订单";
const schema = process.env.DATABASE_TEST_SCHEMA || undefined;
const databaseName = process.env.DATABASE_TEST_DATABASE || undefined;
const permissionQuery = process.env.DATABASE_PERMISSION_QUERY;
const outputPath =
  process.env.DATABASE_EVIDENCE_PATH ?? `docs/connection-expansion/evidence/${service}-real-engine.json`;
const container = process.env.DATABASE_CONTAINER;
const execFileAsync = promisify(execFile);

setPrivateNetworkAccessAllowed(true);
process.env.CONNECTION_DATABASE_EGRESS_ALLOWLIST ??= credentials.host ?? new URL(credentials.baseUrl).hostname;

const module = (await import(`../src/providers/${service}/definition.ts`)) as { provider: ProviderDefinition };
const executorModule = () => import(`../src/providers/${service}/executors.ts`);
const provider = module.provider;
const controlDatabase = new DatabaseSync(":memory:");
const catalog = createCatalogStore([provider], {
  executableActionIds: provider.actions.map((action) => action.id),
});
const app = createConnectionControlApp({
  catalog,
  providerLoader: new ProviderLoader({ [service]: executorModule }),
  controlDatabase,
  secretCodec: new AesGcmSecretCodec("database-e2e-encryption-key"),
  authSecret: "database-e2e-auth-secret",
  publicOrigin: "http://connection-service.test",
  enablement: [{ service, tier: "beta", connectorDefinitionVersion: "1.0.0", owner: "connection-expansion-w1" }],
});
const primary = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  subject: "user-a",
  ownerId: "user-a",
  audience: "database-e2e",
};
const other = { ...primary, tenantId: "tenant-b", workspaceId: "workspace-b", subject: "user-b", ownerId: "user-b" };
const auth = createPrincipalToken(primary, "database-e2e-auth-secret");
const otherAuth = createPrincipalToken(other, "database-e2e-auth-secret");
const checks: Record<string, boolean> = {};

try {
  const wrong = await request("/v1/connections", auth, {
    service,
    authType: "custom_credential",
    connectionName: "wrong-password",
    values: { ...credentials, password: `${credentials.password}-wrong` },
  });
  checks.wrongPasswordRejected = wrong.status === 400;

  const tlsValues =
    service === "clickhouse"
      ? { ...credentials, baseUrl: credentials.baseUrl.replace(/^http:/, "https:") }
      : { ...credentials, tls: "verify-full" };
  const tls = await request("/v1/connections", auth, {
    service,
    authType: "custom_credential",
    connectionName: "bad-tls",
    values: tlsValues,
  });
  checks.tlsFailureRejected = tls.status === 400;

  const created = await request("/v1/connections", auth, {
    service,
    authType: "custom_credential",
    connectionName: "e2e",
    values: credentials,
  });
  await expectStatus(created, 201, "create");
  const createdBody = await json(created);
  const connectionId = requiredNestedString(createdBody, "connection", "id");
  checks.created = true;
  checks.responseRedacted = !JSON.stringify(createdBody).includes(credentials.password);

  const stored = controlDatabase
    .prepare("select credential_ciphertext from tenant_connections where id=?")
    .get(connectionId) as { credential_ciphertext: string };
  checks.encryptedAtRest =
    stored.credential_ciphertext.startsWith("enc:v1:") && !stored.credential_ciphertext.includes(credentials.password);

  const validation = await request(`/v1/connections/${connectionId}/validate`, auth, {});
  await expectStatus(validation, 202, "validate");
  checks.validated = requiredNestedString(await json(validation), "job", "status") === "succeeded";

  const actionIds = provider.actions.map((action) => action.id);
  const lease = await request(`/v1/connections/${connectionId}/lease`, auth, {
    allowedActions: actionIds,
    invocationId: "database-e2e-invocation",
    audience: "database-e2e",
    ttlSeconds: 300,
  });
  await expectStatus(lease, 201, "lease");
  const leaseBody = await json(lease);
  const leaseToken = requiredNestedString(leaseBody, "token");
  const leaseJti = requiredNestedString(leaseBody, "claims", "jti");

  const expiringLease = await request(`/v1/connections/${connectionId}/lease`, auth, {
    allowedActions: [`${service}.validate_connection`],
    invocationId: "expiring-invocation",
    audience: "database-e2e",
    ttlSeconds: 1,
  });
  const expiringToken = requiredNestedString(await json(expiringLease), "token");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const expired = await request(
    `/v1/runtime/actions/${service}.validate_connection`,
    auth,
    { connectionId, invocationId: "expiring-invocation", audience: "database-e2e", input: {} },
    expiringToken,
  );
  checks.expiredLeaseRejected =
    expired.status === 400 && readPath(await json(expired), "error", "code") === "lease_expired";

  const invoke = async (action: string, input: Record<string, unknown>) =>
    request(
      `/v1/runtime/actions/${service}.${action}`,
      auth,
      { connectionId, invocationId: "database-e2e-invocation", audience: "database-e2e", input },
      leaseToken,
    );

  for (const [action, input] of [
    ["validate_connection", {}],
    ["list_databases", { pageSize: 20 }],
    ["list_schemas", { database: databaseName, pageSize: 20 }],
    ["list_tables", { database: databaseName, schema, pageSize: 20 }],
    ["describe_table", { database: databaseName, schema, table }],
    ["preview_table", { database: databaseName, schema, table, pageSize: 1 }],
  ] as const) {
    const response = await invoke(action, removeUndefined(input));
    await expectStatus(response, 200, action);
    const body = await json(response);
    checks[action] = body.ok === true && body.auditPersisted === true;
    if (action === "preview_table") {
      checks.resultTruncation = Boolean(readPath(body, "result", "output", "truncated"));
    }
  }

  const query = queryFor(service);
  const read = await invoke("execute_read_query", {
    query: query.sql,
    parameters: [query.id],
    maxRows: 10,
    timeoutMs: 5_000,
  });
  await expectStatus(read, 200, "parameterized read");
  const readBody = await json(read);
  checks.parameterizedRead = readBody.ok === true && readPath(readBody, "result", "output", "rowCount") === 1;

  const injection = await invoke("execute_read_query", {
    query: query.injectionSql,
    parameters: ["1 OR 1=1; DROP TABLE users"],
    maxRows: 10,
  });
  await expectStatus(injection, 200, "bound injection value");
  checks.sqlInjectionBound =
    readPath(await json(injection), "result", "output", "rows", "0", query.injectionColumn) ===
    "1 OR 1=1; DROP TABLE users";

  for (const [name, sql] of Object.entries({
    multiStatement: "select 1; select 2",
    insertRejected: "insert into blocked_table values (1)",
    updateRejected: "update blocked_table set id = 1",
    deleteRejected: "delete from blocked_table",
    ddlRejected: "drop table blocked_table",
  })) {
    const rejected = await invoke("execute_read_query", { query: sql });
    checks[name] =
      rejected.status === 502 &&
      readPath(await json(rejected), "result", "error", "code") === "database_query_rejected";
  }

  if (permissionQuery) {
    const denied = await invoke("execute_read_query", { query: permissionQuery });
    checks.permissionDenied =
      denied.status === 502 && readPath(await json(denied), "result", "error", "code") === "database_permission_denied";
  }

  const emptyInput = {
    database:
      service === "postgresql" || service === "sql_server" || service === "oracle_database"
        ? databaseName
        : "__openconnector_empty__",
    schema:
      service === "postgresql" || service === "sql_server" || service === "oracle_database"
        ? "OPENCONNECTOR_EMPTY"
        : undefined,
    pageSize: 20,
  };
  const empty = await invoke("list_tables", removeUndefined(emptyInput));
  await expectStatus(empty, 200, "empty discovery");
  const emptyTables = readPath(await json(empty), "result", "output", "tables");
  checks.emptyDiscovery = Array.isArray(emptyTables) && emptyTables.length === 0;

  const timeout = await invoke("execute_read_query", { query: timeoutQueryFor(service), timeoutMs: 100 });
  checks.timeoutClassified =
    timeout.status === 502 && readPath(await json(timeout), "result", "error", "code") === "database_timeout";

  const unreachableValues =
    service === "clickhouse" ? { ...credentials, baseUrl: "http://192.168.71.84:9" } : { ...credentials, port: "9" };
  const unreachable = await request("/v1/connections", auth, {
    service,
    authType: "custom_credential",
    connectionName: "unreachable",
    values: unreachableValues,
  });
  checks.networkFailureRejected = unreachable.status === 400;

  if (container) {
    await execFileAsync("docker", ["stop", container]);
    const disconnected = await invoke("validate_connection", {});
    checks.disconnectDetected =
      disconnected.status === 502 &&
      readPath(await json(disconnected), "result", "error", "code") === "database_network_failed";
    await execFileAsync("docker", ["start", container]);
    await waitForRecovery();
    const recovered = await invoke("validate_connection", {});
    checks.reconnected = recovered.status === 200;
  }

  const otherList = await app.request("/v1/connections", {
    headers: { authorization: `Bearer ${otherAuth}` },
  });
  checks.crossTenantIsolation =
    otherList.status === 200 && (readPath(await json(otherList), "items") as unknown[]).length === 0;

  const audit = await app.request("/v1/audit", { headers: { authorization: `Bearer ${auth}` } });
  await expectStatus(audit, 200, "audit");
  const auditText = await audit.text();
  const auditItems = JSON.parse(auditText).items as Array<Record<string, unknown>>;
  checks.auditPersisted = auditItems.length >= 10;
  checks.auditCarriesInvocationId = auditItems.some((item) => item.invocationId === "database-e2e-invocation");
  checks.auditRedacted = !auditText.includes(credentials.password);

  const revoke = await request(`/v1/leases/${leaseJti}/revoke`, auth, {});
  checks.leaseRevoked = revoke.status === 200;
  const revokedInvocation = await invoke("validate_connection", {});
  checks.revokedLeaseRejected = revokedInvocation.status === 400;

  const replacementLease = await request(`/v1/connections/${connectionId}/lease`, auth, {
    allowedActions: actionIds,
    invocationId: "replacement-invocation",
    audience: "database-e2e",
    ttlSeconds: 300,
  });
  const replacementToken = requiredNestedString(await json(replacementLease), "token");
  const replaced = await request("/v1/connections", auth, {
    service,
    authType: "custom_credential",
    connectionName: "e2e",
    values: credentials,
  });
  await expectStatus(replaced, 201, "credential replacement");
  const oldLease = await request(
    `/v1/runtime/actions/${service}.validate_connection`,
    auth,
    {
      connectionId,
      invocationId: "replacement-invocation",
      audience: "database-e2e",
      input: {},
    },
    replacementToken,
  );
  checks.credentialRotationRevokesLease = oldLease.status === 400;

  const deleted = await app.request(`/v1/connections/${connectionId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${auth}` },
  });
  checks.deleted = deleted.status === 204;
  const afterDelete = await app.request("/v1/connections", { headers: { authorization: `Bearer ${auth}` } });
  const remaining = readPath(await json(afterDelete), "items") as Array<Record<string, unknown>>;
  checks.deletedNotVisible = !remaining.some((item) => item.id === connectionId);

  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed);
  const evidence = {
    schemaVersion: 1,
    service,
    engineImage: image,
    capturedAt: new Date().toISOString(),
    environment: { architecture: process.arch, platform: process.platform },
    checks,
    passed: failedChecks.length === 0,
    notes: ["Credentials, host connection strings, lease tokens, and result values are intentionally omitted."],
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ service, evidence: outputPath, passed: evidence.passed, checks }));
  if (failedChecks.length > 0) process.exitCode = 1;
} finally {
  controlDatabase.close();
}
process.exit(process.exitCode ?? 0);

async function request(
  path: string,
  token: string,
  body: Record<string, unknown>,
  leaseToken?: string,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(leaseToken ? { "x-connection-lease": leaseToken } : {}),
    },
    body: JSON.stringify(body),
  });
}

function queryFor(providerService: string): {
  sql: string;
  id: string | number;
  injectionSql: string;
  injectionColumn: string;
} {
  if (providerService === "postgresql") {
    return {
      sql: `select * from "订单" where id = $1`,
      id: 1,
      injectionSql: "select $1::text as value",
      injectionColumn: "value",
    };
  }
  if (providerService === "sql_server") {
    return {
      sql: `select * from [${table.replaceAll("]", "]]")}] where id = @p1`,
      id: 1,
      injectionSql: "select cast(@p1 as nvarchar(200)) as value",
      injectionColumn: "value",
    };
  }
  if (providerService === "clickhouse") {
    return {
      sql: `select * from \`${table.replaceAll("`", "``")}\` where id = {p1:UInt32}`,
      id: 1,
      injectionSql: "select {p1:String} as value",
      injectionColumn: "value",
    };
  }
  if (providerService === "oracle_database") {
    return {
      sql: `select * from "${(process.env.DATABASE_TEST_SCHEMA ?? "STEP3B").replaceAll('"', '""')}"."${table.replaceAll('"', '""')}" where "ORDER_ID" = :p1`,
      id: "O-2",
      injectionSql: "select cast(:p1 as varchar2(200)) as value from dual",
      injectionColumn: "VALUE",
    };
  }
  return {
    sql: `select * from \`${table.replaceAll("`", "``")}\` where id = ?`,
    id: 1,
    injectionSql: "select cast(? as char) as value",
    injectionColumn: "value",
  };
}

function timeoutQueryFor(providerService: string): string {
  if (providerService === "postgresql") {
    return "select count(*) from generate_series(1, 1000000000)";
  }
  if (providerService === "sql_server") {
    return "select count_big(*) from sys.all_objects a cross join sys.all_objects b cross join sys.all_objects c";
  }
  if (providerService === "clickhouse") {
    return "select sum(sipHash64(sipHash64(number, number+1), sipHash64(number+2, number+3), sipHash64(number+4, number+5), sipHash64(number+6, number+7))) from numbers(10000000)";
  }
  if (providerService === "oracle_database") {
    return "select count(*) from all_objects a cross join all_objects b cross join all_objects c";
  }
  return "select count(*) from information_schema.columns a cross join information_schema.columns b cross join information_schema.columns c";
}

async function waitForRecovery(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await request("/v1/connections", auth, {
      service,
      authType: "custom_credential",
      connectionName: "recovery-probe",
      values: credentials,
    });
    if (response.status === 201) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Database did not recover within 30 seconds.");
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function expectStatus(response: Response, expected: number, phase: string): Promise<void> {
  if (response.status !== expected) {
    throw new Error(`${phase} returned HTTP ${response.status}: ${await response.clone().text()}`);
  }
}

function requiredNestedString(value: unknown, ...path: string[]): string {
  const result = readPath(value, ...path);
  if (typeof result !== "string" || !result) throw new Error(`Missing ${path.join(".")}.`);
  return result;
}

function readPath(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      current = current[Number(key)];
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}
