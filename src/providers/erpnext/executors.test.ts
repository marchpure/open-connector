import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { describe, expect, it } from "vitest";
import { proxy } from "./executors.ts";

function context(values: Record<string, string> = {}): ExecutionContext {
  const credential: Extract<ResolvedCredential, { authType: "api_key" }> = {
    authType: "api_key",
    apiKey: "key",
    values: { baseUrl: "https://erp.example.com", apiSecret: "secret", ...values },
    profile: { accountId: "user", displayName: "User", grantedScopes: [] },
    metadata: {},
  };
  return { getCredential: async () => credential };
}

describe("ERPNext compatibility proxy policy", () => {
  it("rejects writes and generic method endpoints", async () => {
    await expect(proxy({ method: "POST", endpoint: "/api/resource/Customer" }, context())).resolves.toMatchObject({
      ok: false,
      error: { details: { status: 403 } },
    });
    await expect(
      proxy({ method: "GET", endpoint: "/api/method/frappe.client.get_value" }, context()),
    ).resolves.toMatchObject({ ok: false, error: { details: { status: 403 } } });
  });

  it("rejects unbounded query parameters and company-scoped proxy use", async () => {
    await expect(
      proxy({ method: "GET", endpoint: "/api/resource/Customer", query: { limit_page_length: 201 } }, context()),
    ).resolves.toMatchObject({ ok: false, error: { details: { status: 400 } } });
    await expect(
      proxy(
        { method: "GET", endpoint: "/api/resource/Customer", query: { limit_page_length: 100, limit_start: 10_000 } },
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, error: { details: { status: 400 } } });
    await expect(
      proxy(
        {
          method: "GET",
          endpoint: "/api/resource/Customer",
          query: { fields: JSON.stringify(Array.from({ length: 51 }, (_, index) => `field_${index}`)) },
        },
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, error: { details: { status: 400 } } });
    await expect(
      proxy({ method: "GET", endpoint: "/api/resource/Customer" }, context({ companyId: "company-a" })),
    ).resolves.toMatchObject({ ok: false, error: { details: { status: 403 } } });
  });
});
