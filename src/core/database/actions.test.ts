import type { ProviderDefinition } from "../types.ts";

import { describe, expect, it } from "vitest";
import { provider as clickhouse } from "../../providers/clickhouse/definition.ts";
import { provider as doris } from "../../providers/doris/definition.ts";
import { provider as mysql } from "../../providers/mysql/definition.ts";
import { provider as postgresql } from "../../providers/postgresql/definition.ts";
import { provider as sqlServer } from "../../providers/sql_server/definition.ts";
import { provider as starrocks } from "../../providers/starrocks/definition.ts";

const providers: ProviderDefinition[] = [postgresql, mysql, sqlServer, clickhouse, doris, starrocks];
const requiredActions = [
  "validate_connection",
  "list_databases",
  "list_schemas",
  "list_tables",
  "describe_table",
  "preview_table",
  "execute_read_query",
];

describe("database provider contracts", () => {
  it("uses the six canonical service ids without aliases", () => {
    expect(providers.map((provider) => provider.service)).toEqual([
      "postgresql",
      "mysql",
      "sql_server",
      "clickhouse",
      "doris",
      "starrocks",
    ]);
  });

  it.each(providers)("$service exposes the required database actions", (provider) => {
    const actionNames = new Set(provider.actions.map((action) => action.name));
    expect(requiredActions.every((name) => actionNames.has(name))).toBe(true);
  });

  it.each(providers)("$service marks passwords and CA material as secret", (provider) => {
    const auth = provider.auth.find((entry) => entry.type === "custom_credential");
    expect(auth?.type).toBe("custom_credential");
    if (auth?.type !== "custom_credential") return;
    expect(auth.fields.find((field) => field.key === "password")?.secret).toBe(true);
    const caCertificate = auth.fields.find((field) => field.key === "caCertificate");
    if (caCertificate) expect(caCertificate.secret).toBe(true);
  });

  it("keeps SQL Server instance and certificate semantics explicit", () => {
    const auth = sqlServer.auth.find((entry) => entry.type === "custom_credential");
    if (auth?.type !== "custom_credential") throw new Error("Missing SQL Server custom credential definition.");
    expect(auth.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining(["database", "instanceName", "encrypt", "trustServerCertificate"]),
    );
  });
});
