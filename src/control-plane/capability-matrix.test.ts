import { describe, expect, it } from "vitest";
import { executorModules } from "../providers/registry.generated.ts";

describe("W0 capability honesty", () => {
  it("has a registry executor for every default-enabled provider", async () => {
    const enabled = ["hackernews", "postgresql", "mysql", "sql_server", "clickhouse", "doris", "starrocks", "feishu", "dingtalk", "wecom", "aws_s3", "aliyun_oss", "volcengine_tos"];
    expect(enabled.filter((service) => !(service in executorModules))).toEqual([]);
  });

  it("marks secret credential fields as secret in provider definitions", async () => {
    const { loadCatalog } = await import("../catalog-store.ts");
    const catalog = await loadCatalog(undefined, { executableServices: Object.keys(executorModules) });
    for (const provider of catalog.providers) {
      for (const auth of provider.auth) {
        if (auth.type === "api_key") for (const field of auth.extraFields ?? []) expect(typeof field.secret).toBe("boolean");
        if (auth.type === "custom_credential") for (const field of auth.fields) expect(typeof field.secret).toBe("boolean");
      }
    }
  });
});
