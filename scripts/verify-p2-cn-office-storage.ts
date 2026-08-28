import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const services = ["tencent_docs", "wps_mcp", "baidu_netdisk", "tencent_cos", "huawei_obs", "minio", "qiniu_kodo"];

const catalog = await Promise.all(
  services.map(async (service) => {
    const value = JSON.parse(await readFile(join(process.cwd(), "catalog", "apps", `${service}.json`), "utf8")) as {
      service: string;
      actions: Array<{ id: string }>;
    };
    assert.equal(value.service, service);
    assert(value.actions.length > 0);
    assert(value.actions.every((action) => action.id.startsWith(`${service}.`)));
    return { service, actions: value.actions.length };
  }),
);

const registry = await readFile(join(process.cwd(), "src", "providers", "registry.generated.ts"), "utf8");
for (const service of services) {
  assert.match(registry, new RegExp(`(?:^|\\s|")${service}(?:"|):`));
  assert.match(registry, new RegExp(`import\\("\\./${service}/executors\\.ts"\\)`));
}

console.log(JSON.stringify({ status: "PASS", providers: catalog }, null, 2));
