import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselineDir = join(root, "docs/data-workshop-v1/v3");
const failures = [];

function read(relativePath) {
  return readFileSync(join(baselineDir, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function yamlPathBlock(document, path) {
  const lines = document.split("\n");
  const keys = new Set([`  ${path}:`, `  "${path}":`, `  '${path}':`]);
  const start = lines.findIndex((line) => keys.has(line));
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  (?:"\/|'\/|\/)/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function hasOperation(document, path, method) {
  return new RegExp(`^    ${method}:\\s*$`, "mu").test(yamlPathBlock(document, path));
}

const manifest = readJson("baseline-manifest.json");
const pins = readJson("REPOSITORY_PINS.json");
const schemas = readJson("contracts/schemas.json");
const openConnectorApi = read("contracts/openapi.yaml");
const bffApi = read("contracts/bff-openapi.yaml");
const routes = read("ROUTE_MATRIX.md");
const migration = read("MIGRATION_LEDGER.md");
const handoff = read("W1_W7_HANDOFF.md");
const tests = read("TEST_MATRIX.md");
const report = read("report/output/index.html");
const reportManifest = readJson("report/artifact-manifest.json");
const contextPack = readJson("report/context-pack.json");
const sources = readJson("report/sources.json");
const citations = readJson("report/citations.json");

assert(manifest.baseline === "DWV1_I0_BASELINE_V3_FROZEN", "wrong baseline marker");
assert(manifest.business_feature_implementation_claimed === false, "I0 must not claim business implementation");

const expectedProducts = new Map([
  ["open-connector", "0fa2c728dfbf957735da2843ec2b8a4f3425b105"],
  ["veadk-data-studio", "9766b3a5e810c12edcfbe3ba43d9a3e0419c2275"],
  ["data-workshop-skill-agent", "495d52e218bcde1b5386c01bcd4be04dc95852d3"],
]);
for (const product of pins.products) {
  assert(product.default_branch === "main", `${product.name}: default branch is not main`);
  assert(product.full_sha === expectedProducts.get(product.name), `${product.name}: wrong full SHA`);
  assert(product.local_tracked_clean === true, `${product.name}: checkout was not clean`);
  assert(product.remote_sha_equal === true, `${product.name}: local/remote SHA mismatch`);
  expectedProducts.delete(product.name);
}
assert(expectedProducts.size === 0, "one or more canonical products are missing");

const donor = pins.dependencies.find((item) => item.role === "read_only_donor_and_legacy_evidence_only");
assert(donor, "donor-only repository declaration missing");
assert(donor?.donor_commits.skill_ui === "9c025a977800bc2abb026ec059813d0a37cd0add", "Skill UI donor SHA mismatch");
assert(
  donor?.donor_commits.openviking_primary === "d203bfb89a36baa908d0e60ef49f6175dd623942",
  "OpenViking primary donor SHA mismatch",
);
assert(
  donor?.donor_commits.openviking_isolation === "7ab6a8697a04cbbfdea7f88aaa27d6c117663fc2",
  "OpenViking isolation donor SHA mismatch",
);
assert(
  pins.dependencies.some((item) => item.role === "sdk_only"),
  "SDK-only repository declaration missing",
);

for (const schemaName of [
  "IdentityProviderConfig",
  "AuthContext",
  "AccessGrant",
  "RoleDefinition",
  "PolicyDecision",
  "KnowledgeResourceRef",
  "McpCapabilityRef",
  "ErrorEnvelope",
]) {
  assert(Boolean(schemas.$defs?.[schemaName]), `missing shared schema ${schemaName}`);
}
assert(
  schemas.$defs.AccessGrant.properties.role_id.enum.join(",") === "reader,operator,custom",
  "role enum is not reader/operator/custom",
);
assert(
  schemas.$defs.AccessGrant.properties.subject_id.description.includes("Stable UserPool ID"),
  "stable subject-ID constraint missing",
);
assert(
  schemas.$defs.IdentityProviderConfig.required.includes("jwks_uri") &&
    schemas.$defs.IdentityProviderConfig.required.includes("subject_claim") &&
    schemas.$defs.IdentityProviderConfig.required.includes("group_claim"),
  "identity-provider JWT/JWKS claims are incomplete",
);

for (const path of [
  "/v1/identity-provider:",
  "/v1/identity-provider:validate:",
  "/v1/identity/subjects:",
  "/v1/access-grants:",
  "/v1/access-grants/{grantId}:",
  "/v1/access-grants/{grantId}:revoke:",
  "/v1/access:preview:",
  "/v1/access/audit:",
  "/v1/mcp/config:",
  "/v1/mcp/status:",
  "/mcp:",
]) {
  const normalizedPath = path.slice(0, -1);
  assert(yamlPathBlock(openConnectorApi, normalizedPath), `OpenConnector API missing ${normalizedPath}`);
}
assert(hasOperation(openConnectorApi, "/v1/connections", "patch"), "PATCH /v1/connections is not frozen");
assert(hasOperation(openConnectorApi, "/v1/access-grants", "patch"), "PATCH /v1/access-grants is not frozen");
assert(hasOperation(openConnectorApi, "/mcp", "post"), "POST /mcp is not frozen");
assert(!hasOperation(openConnectorApi, "/mcp", "get"), "GET /mcp must not be an OpenConnector API operation");
assert(
  !/publication/iu.test(openConnectorApi.replace(/Publication resources do not exist\./u, "")),
  "Publication API leaked",
);
for (const path of [
  "/v1/bootstrap:",
  "/v1/openconnector/launch-sessions:",
  "/v1/connections/{connectionId}/access:",
  "/v1/access-grants:",
  "/v1/access:preview:",
  "/v1/access/audit:",
  "/v1/connection-docs/config:",
  "/v1/connection-docs/status:",
  "/v1/openviking/profiles:",
  "/v1/openviking/resources:",
  "/v1/openviking/tasks:",
  "/v1/openviking/watches:",
  "/v1/skills:",
  "/v1/sessions/{sessionId}:",
  "/v1/artifacts/{artifactId}/download:",
]) {
  const normalizedPath = path.slice(0, -1);
  assert(yamlPathBlock(bffApi, normalizedPath), `BFF API missing ${normalizedPath}`);
}
assert(!yamlPathBlock(bffApi, "/mcp"), "BFF must not proxy the MCP data plane");

for (const path of [
  "/home",
  "/connections/overview",
  "/connections/providers",
  "/connections/providers/market",
  "/connections/providers/new/oracle",
  "/connections/providers/:id",
  "/connections/providers/:id/access",
  "/connections/actions",
  "/connections/trace",
  "/connections/access",
  "/connections/docs",
  "/kb",
  "/kb/connect",
  "/kb/resources",
  "/kb/retrieval",
  "/kb/tasks",
  "/kb/watch",
  "/skill",
  "/skill/new",
  "/skill/:id",
  "/sessions",
]) {
  assert(routes.includes(`\`${path}\``), `route matrix missing ${path}`);
}
for (const legacyPath of ["/mcp", "/mcp/new", "/mcp/:id", "/mcp/not-found"]) {
  assert(routes.includes(`GET ${legacyPath}`), `legacy redirect missing ${legacyPath}`);
}

for (let workstream = 1; workstream <= 7; workstream += 1) {
  assert(handoff.includes(`## W${workstream} `), `handoff missing W${workstream}`);
}
assert(migration.includes("SUPERSEDED_BY_DWV1_I0_BASELINE_V3"), "superseded marker missing");
assert(migration.includes("DO_NOT_INTEGRATE"), "do-not-integrate marker missing");
assert(tests.includes("explicit deny"), "explicit-deny test obligation missing");
assert(tests.includes("JWKS refresh"), "JWKS refresh test obligation missing");
assert(tests.includes("per-call authorization"), "per-call authorization test obligation missing");

assert(reportManifest.main_entry === "output/index.html", "report main entry mismatch");
assert(reportManifest.published_url.startsWith("https://"), "report URL must be HTTPS");
assert(reportManifest.source_count === sources.sources.length, "report source count mismatch");
assert(contextPack.sources.length === sources.sources.length, "context-pack source count mismatch");
const sourceIds = new Set(sources.sources.map((source) => source.id));
for (const claim of citations.claims) {
  for (const sourceId of claim.source_ids) {
    assert(sourceIds.has(sourceId), `${claim.claim_id}: unknown source ${sourceId}`);
    assert(report.includes(`href="#${sourceId.toLowerCase()}"`), `${sourceId}: report source anchor missing`);
  }
}
assert(report.includes("DWV1_I0_BASELINE_V3_FROZEN"), "report baseline marker missing");
assert(report.includes("not linked from Data Workshop product"), "report navigation exclusion missing");

if (failures.length > 0) {
  console.error(`DWV1 V3 baseline verification failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("DWV1 V3 baseline verification passed");
console.log(
  `products=${pins.products.length} schemas=${Object.keys(schemas.$defs).length} claims=${citations.claims.length}`,
);
