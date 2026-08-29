import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const services = ["tencent_docs", "wps_mcp", "baidu_netdisk", "tencent_cos", "huawei_obs", "minio", "qiniu_kodo"];
const expectedReadActions: Record<string, string[]> = {
  tencent_docs: [
    "get_current_user",
    "list_folder",
    "search_files",
    "get_file_metadata",
    "get_doc_content",
    "get_sheet_range",
    "list_smartsheet_sheets",
    "get_smartsheet_records",
    "start_export",
    "get_export_progress",
  ],
  wps_mcp: ["search_files", "list_my_files", "list_files", "get_file_info", "read_file"],
  baidu_netdisk: [
    "get_current_account",
    "get_quota",
    "list_files",
    "search_files",
    "semantic_search_files",
    "get_file_metadata",
    "download_file",
  ],
  tencent_cos: ["list_buckets", "list_objects", "head_object", "download_object"],
  huawei_obs: ["list_buckets", "list_objects", "head_object", "download_object"],
  minio: ["list_buckets", "list_objects", "head_object", "download_object"],
  qiniu_kodo: ["list_buckets", "list_objects", "head_object", "download_object"],
};
const prohibitedStorageActions = ["put_object", "delete_object", "generate_presigned_url"];

const catalog = await Promise.all(
  services.map(async (service) => {
    const value = JSON.parse(await readFile(join(process.cwd(), "catalog", "apps", `${service}.json`), "utf8")) as {
      service: string;
      actions: Array<{
        id: string;
        name: string;
        resourceBindings?: Record<string, string[]>;
        resourceBindingsOptional?: Record<string, string[]>;
      }>;
    };
    assert.equal(value.service, service);
    assert(value.actions.length > 0);
    assert(value.actions.every((action) => action.id.startsWith(`${service}.`)));
    const names = new Set(value.actions.map((action) => action.name));
    for (const action of expectedReadActions[service] ?? []) {
      assert(names.has(action), `${service}.${action} is missing`);
    }
    if (["tencent_cos", "huawei_obs", "minio", "qiniu_kodo"].includes(service)) {
      for (const action of prohibitedStorageActions) {
        assert(!names.has(action), `${service}.${action} must remain unavailable`);
      }
      for (const action of value.actions.filter((entry) => entry.name !== "list_buckets")) {
        assert(action.resourceBindings?.bucket, `${action.id} must require a discovered bucket`);
      }
    }
    return { service, actions: value.actions.length, requiredReads: expectedReadActions[service]?.length ?? 0 };
  }),
);

const registry = await readFile(join(process.cwd(), "src", "providers", "registry.generated.ts"), "utf8");
for (const service of services) {
  assert.match(registry, new RegExp(`(?:^|\\s|")${service}(?:"|):`));
  assert.match(registry, new RegExp(`import\\("\\./${service}/executors\\.ts"\\)`));
}

const handoff = JSON.parse(
  await readFile(
    join(process.cwd(), "docs", "connection-expansion", "p2-incremental-cn-office-storage-handoff.json"),
    "utf8",
  ),
) as {
  baseSha: string;
  status: string;
  connections: Array<{ providerId: string; tier: string; externalBlocker?: string }>;
};
assert.equal(handoff.baseSha, "3bbd44624933300487a54ee3acba23190b66ee98");
for (const service of services) {
  const connection = handoff.connections.find((entry) => entry.providerId === service);
  assert(connection, `${service} handoff entry is missing`);
  assert.equal(connection.tier, "beta", `${service} must remain beta without real lifecycle evidence`);
  assert(connection.externalBlocker, `${service} must record its real-account lifecycle blocker`);
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      providers: catalog,
      contractEvidence:
        "Run npm test for provider/runtime/control-plane/security coverage; this verifier checks canonical IDs, required reads, bucket bindings, disabled storage mutations, beta tiers, and explicit external blockers.",
      realAccountLifecycle: handoff.connections.map(({ providerId, externalBlocker }) => ({
        providerId,
        status: "BLOCKED",
        reason: externalBlocker,
      })),
    },
    null,
    2,
  ),
);
