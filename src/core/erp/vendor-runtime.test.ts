import type { ErpRestVendor } from "./vendor-runtime.ts";

import { describe, expect, it, vi } from "vitest";
import { boundedErpFetch, projectErpFields, readErpInput } from "./runtime.ts";
import { defineErpVendorExecutors } from "./vendor-runtime.ts";
import { kingdeeCloudVendor, odooVendor, sapS4hanaVendor, yonyouBipVendor } from "./vendors.ts";

const vendor: ErpRestVendor = {
  service: "fixture_erp",
  displayName: "Fixture ERP",
  apiVersion: "v1",
  authStyle: "bearer",
  validationPath: "/v1/whoami",
  entities: [{ domain: "customer", entity: "v1/customers", fields: ["id", "name"] }],
  buildReadRequest(input) {
    const url = new URL(input.entity.entity, `${input.baseUrl}/`);
    url.searchParams.set("limit", String(input.pageSize));
    return { url };
  },
  parsePage(payload) {
    return { items: (payload as { items: Array<Record<string, unknown>> }).items, native: {} };
  },
};

describe("ERP vendor runtime", () => {
  it("always requests and returns only allowlisted native fields", async () => {
    const entity = sapS4hanaVendor.entities[0]!;
    const input = readErpInput({ domain: "company", pageSize: 1 }, sapS4hanaVendor.entities).input;
    expect(input.fields).toEqual(["CompanyCode", "CompanyCodeName", "Country", "Currency"]);
    const request = sapS4hanaVendor.buildReadRequest({
      ...input,
      baseUrl: "https://erp.example.com",
      entity,
      values: {},
    });
    expect(request.url.searchParams.get("$select")).toBe("CompanyCode,CompanyCodeName,Country,Currency");
    expect(
      projectErpFields(
        {
          CompanyCode: "1000",
          CompanyCodeName: "Example",
          Country: "DE",
          Currency: "EUR",
          SecretField: "must-not-escape",
        },
        input.fields,
      ),
    ).toEqual({
      CompanyCode: "1000",
      CompanyCodeName: "Example",
      Country: "DE",
      Currency: "EUR",
    });
  });

  it("maps Kingdee positional query rows to the selected native FieldKeys", () => {
    const fields = ["FOrgId", "FNumber", "FName"];
    expect(kingdeeCloudVendor.parsePage([[1, "ORG-1", "Example"]], 10, undefined, fields)).toMatchObject({
      items: [{ FOrgId: 1, FNumber: "ORG-1", FName: "Example" }],
      native: { count: 1 },
    });
    expect(() => kingdeeCloudVendor.parsePage([{ FOrgId: 1 }], 10, undefined, fields)).toThrow(/non-array row/);
  });

  it("keeps vendor pagination cursors monotonic across Odoo, Kingdee, and Yonyou", () => {
    expect(odooVendor.parsePage([{ id: 1 }, { id: 2 }], 2, "4", ["id"]).nextCursor).toBe("6");
    expect(
      kingdeeCloudVendor.parsePage(
        [
          [1, "A"],
          [2, "B"],
        ],
        2,
        "4",
        ["id", "name"],
      ).nextCursor,
    ).toBe("6");
    expect(
      yonyouBipVendor.parsePage({ data: { pageIndex: 4, recordList: [{ id: "a" }, { id: "b" }] } }, 2, "4", ["id"])
        .nextCursor,
    ).toBe("5");
    expect(
      yonyouBipVendor.parsePage({ data: { recordList: [{ id: "a" }, { id: "b" }] } }, 2, "4", ["id"]).nextCursor,
    ).toBe("5");
  });

  it("uses the Odoo 19 multi-company field for account reads", () => {
    const account = odooVendor.entities.find((entity) => entity.domain === "account");
    expect(account).toMatchObject({
      entity: "account.account",
      companyField: "company_ids",
      fields: expect.arrayContaining(["company_ids"]),
    });
    expect(
      odooVendor.buildReadRequest({
        baseUrl: "https://odoo.example.com",
        entity: account!,
        pageSize: 2,
        companyId: "1",
        values: {},
      }).body,
    ).toMatchObject({
      domain: [["company_ids", "=", 1]],
      fields: expect.arrayContaining(["company_ids"]),
      limit: 2,
    });
  });

  it("uses server-side credentials during validation without returning the token", async () => {
    const fetcher = vi.fn<typeof fetch>(async (request, init) => {
      expect(String(request)).toBe("https://erp.example.com/v1/whoami");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
      return Response.json({ id: "tenant" });
    });
    const runtime = defineErpVendorExecutors(vendor);
    const result = await runtime.credentialValidators.customCredential(
      { values: { baseUrl: "https://erp.example.com", accessToken: "secret-token", accountId: "tenant" } },
      { fetcher },
    );

    expect(result).toMatchObject({ profile: { accountId: "tenant" }, grantedScopes: ["read"] });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("maps wrong credentials, insufficient roles, throttling, and upstream failures without response details", async () => {
    const runtime = defineErpVendorExecutors(vendor);
    for (const [status, expected] of [
      [401, 401],
      [403, 403],
      [404, 404],
      [429, 429],
      [500, 502],
    ] as const) {
      await expect(
        runtime.credentialValidators.customCredential(
          { values: { baseUrl: "https://erp.example.com", accessToken: "secret-token" } },
          { fetcher: async () => Response.json({ message: "private financial detail" }, { status }) },
        ),
      ).rejects.toMatchObject({ status: expected });
    }
  });

  it("fails closed on redirects and cross-origin continuation URLs", async () => {
    await expect(
      boundedErpFetch(
        async () =>
          new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
        new URL("https://erp.example.com/v1/customers"),
        {},
        "Fixture ERP",
      ),
    ).rejects.toMatchObject({ status: 502, message: "Fixture ERP redirects are disabled" });
  });

  it("aborts requests at the shared ERP timeout", async () => {
    vi.useFakeTimers();
    try {
      const request = boundedErpFetch(
        async (_request, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            );
          }),
        new URL("https://erp.example.com/v1/customers"),
        {},
        "Fixture ERP",
      );
      const assertion = expect(request).rejects.toMatchObject({
        status: 504,
        message: "Fixture ERP request failed",
      });
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("discovers only entities visible to the connected role", async () => {
    const scopedVendor: ErpRestVendor = {
      ...vendor,
      entities: [...vendor.entities, { domain: "supplier", entity: "v1/vendors", fields: ["id", "name"] }],
    };
    const runtime = defineErpVendorExecutors(scopedVendor);
    const resources = await runtime.discoverResources(
      {
        getCredential: async () => ({
          authType: "custom_credential",
          values: { baseUrl: "https://erp.example.com", accessToken: "secret-token" },
          profile: { accountId: "tenant", displayName: "Tenant", grantedScopes: ["read"] },
          metadata: {},
        }),
      },
      async (request) =>
        String(request).includes("/v1/vendors")
          ? Response.json({}, { status: 403 })
          : Response.json({ items: [{ id: "1" }] }),
    );

    expect(resources).toEqual([
      expect.objectContaining({
        sourceType: "fixture_erp",
        resourceId: "customer",
        mimeType: "application/vnd.oomol.erp.customer",
      }),
    ]);
  });

  it("fails discovery on an invalid connection instead of returning empty capabilities", async () => {
    const runtime = defineErpVendorExecutors(vendor);
    await expect(
      runtime.discoverResources(
        {
          getCredential: async () => ({
            authType: "custom_credential",
            values: { baseUrl: "https://erp.example.com", accessToken: "bad-token" },
            profile: { accountId: "tenant", displayName: "Tenant", grantedScopes: ["read"] },
            metadata: {},
          }),
        },
        async () => Response.json({}, { status: 401 }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("returns structured unsupported when the connected role exposes no ERP entity", async () => {
    const runtime = defineErpVendorExecutors(vendor);
    await expect(
      runtime.discoverResources(
        {
          getCredential: async () => ({
            authType: "custom_credential",
            values: { baseUrl: "https://erp.example.com", accessToken: "limited-token" },
            profile: { accountId: "tenant", displayName: "Tenant", grantedScopes: ["read"] },
            metadata: {},
          }),
        },
        async (request) =>
          String(request).endsWith("/v1/whoami") ? Response.json({ id: "tenant" }) : Response.json({}, { status: 403 }),
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "unsupported", supportedDomains: [] },
    });
  });
});
