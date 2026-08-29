import { describe, expect, it } from "vitest";
import { isAllowedDataPlatformLeaseAction } from "./data-platform-policy.ts";

describe("data platform lease policy", () => {
  it("allows only canonical SQL read actions for SQL data connectors", () => {
    expect(isAllowedDataPlatformLeaseAction("oracle_database", "oracle_database.execute_read_query")).toBe(true);
    expect(isAllowedDataPlatformLeaseAction("oracle_database", "oracle_database.insert")).toBe(false);
    expect(isAllowedDataPlatformLeaseAction("tidb_sql", "tidb_sql.execute_read_query")).toBe(true);
    expect(isAllowedDataPlatformLeaseAction("tidb_sql", "tidb.execute_read_query")).toBe(false);
    expect(isAllowedDataPlatformLeaseAction("trino", "trino.drop_table")).toBe(false);
  });

  it("keeps Elasticsearch mutations outside Agent leases", () => {
    expect(isAllowedDataPlatformLeaseAction("elasticsearch", "elasticsearch.query_index")).toBe(true);
    expect(isAllowedDataPlatformLeaseAction("elasticsearch", "elasticsearch.delete_index")).toBe(false);
    expect(isAllowedDataPlatformLeaseAction("elasticsearch", "elasticsearch.reindex")).toBe(false);
  });

  it("does not change lease behavior for providers outside this increment", () => {
    expect(isAllowedDataPlatformLeaseAction("fixture", "fixture.read")).toBe(true);
  });
});
