import { afterEach, describe, expect, it } from "vitest";
import { setPrivateNetworkAccessAllowed } from "../request.ts";
import {
  assertReadOnlySuiteql,
  boundedErpFetch,
  erpActionOutput,
  erpMaxConcurrency,
  erpMaxPages,
  normalizeErpBaseUrl,
  readErpInput,
  requireErpCompanyField,
  resolveErpCompanyId,
} from "./runtime.ts";
import { odataReadRequest, parseOraclePage } from "./vendor-runtime.ts";

const entities = [
  { domain: "customer" as const, entity: "Customers", fields: ["id", "name"], companyField: "CompanyCode" },
  { domain: "supplier" as const, entity: "Vendors", fields: ["id", "name"] },
];

afterEach(() => {
  setPrivateNetworkAccessAllowed(false);
  delete process.env.CONNECTION_ERP_PRIVATE_RUNNER;
  delete process.env.CONNECTION_ERP_EGRESS_ALLOWLIST;
});

describe("ERP read contract", () => {
  it("returns structured unsupported details instead of an empty successful read", () => {
    expect(() => readErpInput({ domain: "general_ledger" }, entities)).toThrowError(
      expect.objectContaining({
        status: 422,
        details: {
          code: "unsupported",
          domain: "general_ledger",
          supportedDomains: ["customer", "supplier"],
        },
      }),
    );
  });

  it("bounds pages, projections, cursors, and date windows", () => {
    expect(() => readErpInput({ domain: "customer", pageSize: 201 }, entities)).toThrow(/pageSize/);
    expect(() => readErpInput({ domain: "customer", fields: ["password"] }, entities)).toThrow(/Unsupported field/);
    expect(() =>
      readErpInput(
        { domain: "customer", modifiedFrom: "2024-01-01T00:00:00Z", modifiedTo: "2026-01-02T00:00:00Z" },
        entities,
      ),
    ).toThrow(/366 days/);
    expect(() => readErpInput({ domain: "customer", modifiedFrom: "2026-01-01T00:00:00Z" }, entities)).toThrow(
      /provided together/,
    );
    expect(() =>
      odataReadRequest({
        baseUrl: "https://erp.example.com",
        entity: entities[0]!,
        pageSize: 10,
        cursor: "https://attacker.example/steal",
        values: {},
      }),
    ).toThrow(/configured ERP origin/);
  });

  it("wraps native cursors in a bounded opaque page envelope", () => {
    const first = erpActionOutput(entities[0]!, { items: [{ id: "1" }], nextCursor: "native-2", native: {} }, 1);
    expect(first.native).toMatchObject({ pageNumber: 1 });
    const second = readErpInput({ domain: "customer", cursor: first.nextCursor }, entities).input;
    expect(second).toMatchObject({ cursor: "native-2", pageNumber: 2 });
    expect(
      erpActionOutput(
        entities[0]!,
        { items: [{ id: "last" }], nextCursor: "native-overflow", native: {} },
        erpMaxPages,
      ),
    ).toMatchObject({
      items: [{ id: "last" }],
      nextCursor: null,
      native: { pageNumber: erpMaxPages, pageBudgetExhausted: true },
    });
    expect(() => readErpInput({ domain: "customer", cursor: "not-an-erp-cursor" }, entities)).toThrow(/cursor/);
  });

  it("escapes OData filter literals and preserves provider-native pagination", () => {
    const request = odataReadRequest({
      baseUrl: "https://erp.example.com",
      entity: entities[0]!,
      pageSize: 10,
      companyId: "a' or 1 eq 1",
      values: {},
    });
    expect(request.url.searchParams.get("$filter")).toBe("CompanyCode eq 'a'' or 1 eq 1'");
    const continued = odataReadRequest({
      baseUrl: "https://erp.example.com",
      entity: entities[0]!,
      pageSize: 10,
      cursor: "https://erp.example.com/Customers?$skiptoken=opaque&$filter=CompanyCode%20eq%20%27attacker%27",
      companyId: "company-a",
      values: {},
    });
    expect(continued.url.searchParams.get("$skiptoken")).toBe("opaque");
    expect(continued.url.searchParams.get("$filter")).toBe("CompanyCode eq 'company-a'");
    expect(() =>
      odataReadRequest({
        baseUrl: "https://erp.example.com",
        entity: entities[0]!,
        pageSize: 10,
        cursor: "https://erp.example.com/AdminUsers?$skiptoken=opaque",
        values: {},
      }),
    ).toThrow(/selected ERP entity/);
    expect(() =>
      odataReadRequest({
        baseUrl: "https://erp.example.com",
        entity: entities[1]!,
        pageSize: 10,
        companyId: "company-a",
        values: {},
      }),
    ).toThrowError(
      expect.objectContaining({
        status: 422,
        details: { code: "unsupported", domain: "supplier", feature: "companyId" },
      }),
    );
    expect(parseOraclePage({ items: [{ id: 1 }, { id: 2 }], offset: 20, hasMore: true })).toMatchObject({
      nextCursor: "22",
      native: { offset: 20, hasMore: true },
    });
  });

  it("accepts only a single read-only SuiteQL statement", () => {
    expect(assertReadOnlySuiteql("SELECT id FROM customer;")).toBe("SELECT id FROM customer");
    expect(() => assertReadOnlySuiteql("select id from customer; delete from customer")).toThrow(/read-only/);
    expect(() => assertReadOnlySuiteql("update customer set name = 'x'")).toThrow(/read-only/);
  });

  it("requires both the private-runner flag and exact ERP host allowlist", () => {
    expect(() => normalizeErpBaseUrl("http://10.0.0.8", { privateRunner: true })).toThrow(
      /CONNECTION_ERP_PRIVATE_RUNNER/,
    );
    process.env.CONNECTION_ERP_PRIVATE_RUNNER = "true";
    expect(() => normalizeErpBaseUrl("http://10.0.0.8", { privateRunner: true })).toThrow(
      /OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK/,
    );
    setPrivateNetworkAccessAllowed(true);
    expect(() => normalizeErpBaseUrl("http://10.0.0.8", { privateRunner: true })).toThrow(
      /CONNECTION_ERP_EGRESS_ALLOWLIST/,
    );
    process.env.CONNECTION_ERP_EGRESS_ALLOWLIST = "10.0.0.8";
    expect(normalizeErpBaseUrl("http://10.0.0.8", { privateRunner: true })).toBe("http://10.0.0.8");
    expect(() => normalizeErpBaseUrl("http://10.0.0.9", { privateRunner: true })).toThrow(/not in/);
  });

  it("binds company selectors to the configured legal entity", () => {
    expect(resolveErpCompanyId(undefined, "company-a")).toBe("company-a");
    expect(resolveErpCompanyId("company-a", "company-a")).toBe("company-a");
    expect(() => resolveErpCompanyId("company-b", "company-a")).toThrow(/outside/);
    expect(() => resolveErpCompanyId("company-a", undefined)).toThrow(/not allowlisted/);
    expect(requireErpCompanyField(entities[0]!, "company-a")).toBe("CompanyCode");
    expect(() => requireErpCompanyField(entities[1]!, "company-a")).toThrowError(
      expect.objectContaining({
        status: 422,
        details: { code: "unsupported", domain: "supplier", feature: "companyId" },
      }),
    );
  });

  it("rejects oversized responses before parsing ERP data", async () => {
    await expect(
      boundedErpFetch(
        async () =>
          new Response("x".repeat(4 * 1024 * 1024 + 1), {
            headers: { "content-type": "application/json" },
          }),
        new URL("https://erp.example.com/data"),
        {},
        "Fixture ERP",
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("rejects disconnected transports with a stable redacted error", async () => {
    await expect(
      boundedErpFetch(
        async () => {
          throw new TypeError("socket failed at private-host with token secret");
        },
        new URL("https://erp.example.com/data"),
        {},
        "Fixture ERP",
      ),
    ).rejects.toMatchObject({ status: 502, message: "Fixture ERP request failed" });
  });

  it("enforces the shared ERP concurrency budget", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = async (): Promise<Response> => {
      await blocked;
      return Response.json({});
    };
    const requests = Array.from({ length: erpMaxConcurrency }, () =>
      boundedErpFetch(fetcher, new URL("https://erp.example.com/data"), {}, "Fixture ERP"),
    );
    await expect(
      boundedErpFetch(fetcher, new URL("https://erp.example.com/data"), {}, "Fixture ERP"),
    ).rejects.toMatchObject({ status: 429 });
    release();
    await Promise.all(requests);
  });
});
