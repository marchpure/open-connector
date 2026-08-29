import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadCatalog } from "../src/catalog-store.ts";
import { executorModules } from "../src/providers/registry.generated.ts";

const root = process.cwd();
const output = join(root, "docs/connection-expansion/w0-capability-matrix.json");
const catalog = await loadCatalog(undefined, { executableServices: Object.keys(executorModules) });
const enabled = new Map([
  ["hackernews", ["catalog", "docs/knowledge-workspace/evidence/step2-existing-replay-final.json"]],
  ["postgresql", ["verified", "docs/connection-expansion/evidence/postgresql-real-engine.json"]],
  ["mysql", ["verified", "docs/connection-expansion/evidence/mysql-real-engine.json"]],
  ["sql_server", ["beta", "docs/connection-expansion/evidence/sql-server-external-blocker.json"]],
  ["clickhouse", ["verified", "docs/connection-expansion/evidence/clickhouse-real-engine.json"]],
  ["doris", ["verified", "docs/connection-expansion/evidence/doris-real-engine.json"]],
  ["starrocks", ["verified", "docs/connection-expansion/evidence/starrocks-real-engine.json"]],
  ["feishu", ["beta", "docs/connection-expansion/w2-office-storage-handoff.json#/connections/0"]],
  ["dingtalk", ["beta", "docs/connection-expansion/w2-office-storage-handoff.json#/connections/1"]],
  ["wecom", ["beta", "docs/connection-expansion/w2-office-storage-handoff.json#/connections/2"]],
  ["aws_s3", ["beta", "docs/connection-expansion/w2-office-storage-handoff.json#/connections/3"]],
  ["aliyun_oss", ["beta", "docs/connection-expansion/w2-office-storage-handoff.json#/connections/4"]],
  ["volcengine_tos", ["beta", "docs/connection-expansion/w2-office-storage-handoff.json#/connections/5"]],
]);

function fields(provider: (typeof catalog.providers)[number]): string[] {
  return provider.auth.flatMap((auth) => {
    if (auth.type === "no_auth") return [];
    if (auth.type === "api_key") return ["apiKey", ...(auth.extraFields ?? []).map((field) => field.key)];
    if (auth.type === "custom_credential") return auth.fields.map((field) => field.key);
    return (auth.clientConfigFields ?? []).map((field) => field.key);
  });
}

const providers = catalog.providers.map((provider) => {
  const state = enabled.get(provider.service);
  const executorPresent = provider.actions.some((action) => action.execution.locallyExecutable);
  const actions = provider.actions.map((action) => action.name);
  return {
    service_id: provider.service,
    display_name: provider.displayName,
    category: provider.categories,
    frontend_visible: true,
    frontend_enabled: state !== undefined,
    configuration_fields: fields(provider),
    credential_mode: provider.authTypes,
    oauth_callback: provider.auth.some((auth) => auth.type === "oauth2"),
    executor_present: executorPresent,
    actions,
    tier: state?.[0] ?? "catalog",
    local_testable: executorPresent && provider.authTypes.includes("no_auth"),
    external_account_required: !provider.authTypes.includes("no_auth"),
    create: state !== undefined,
    validate: executorPresent,
    discover: executorPresent,
    preview: executorPresent,
    lease: state !== undefined && executorPresent,
    action: executorPresent,
    audit: state !== undefined && executorPresent,
    revoke: state !== undefined,
    restart: state !== undefined,
    skill_context: state !== undefined && executorPresent,
    skill_e2e: false,
    evidence_ref: state?.[1] ?? null,
    blocker: state && !executorPresent ? "enabled_without_executor" : (state ? "external_account_or_lifecycle_evidence" : null),
    owner: "knowledge-platform",
  };
});

const adapters = ["oracle_database", "rest_openapi", "mcp", "files"].map((service_id) => ({
  service_id,
  display_name: service_id === "oracle_database" ? "Oracle Database" : service_id === "rest_openapi" ? "REST / OpenAPI" : service_id === "mcp" ? "MCP Server" : "Files",
  category: ["adapter"], frontend_visible: true, frontend_enabled: true, configuration_fields: [], credential_mode: [], oauth_callback: false,
  executor_present: true, actions: [], tier: "beta", local_testable: service_id === "files" || service_id === "rest_openapi" || service_id === "mcp",
  external_account_required: service_id === "oracle_database", create: true, validate: true, discover: true, preview: service_id === "files", lease: true, action: true, audit: true, revoke: true, restart: true,
  skill_context: false, skill_e2e: false, evidence_ref: null, blocker: service_id === "oracle_database" ? "external_account_required" : null, owner: "knowledge-platform",
}));
const items = [...providers, ...adapters];
await mkdir(join(root, "docs/connection-expansion"), { recursive: true });
await writeFile(output, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), catalogProviders: catalog.providers.length, catalogActions: catalog.actions.length, items }, null, 2) + "\n");
console.log(JSON.stringify({ output, providers: catalog.providers.length, actions: catalog.actions.length, items: items.length }));
