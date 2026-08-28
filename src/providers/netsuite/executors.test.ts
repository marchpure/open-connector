import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { describe, expect, it, vi } from "vitest";
import { proxy } from "./executors.ts";
import { validateNetsuiteCredential } from "./runtime.ts";

function context(values: Record<string, string> = {}): ExecutionContext {
  const credential: Extract<ResolvedCredential, { authType: "custom_credential" }> = {
    authType: "custom_credential",
    values: {
      accountId: "1234567",
      consumerKey: "consumer-key",
      consumerSecret: "consumer-secret",
      tokenId: "token-id",
      tokenSecret: "token-secret",
      ...values,
    },
    profile: { accountId: "1234567", displayName: "NetSuite", grantedScopes: [] },
    metadata: {},
  };
  return { getCredential: async () => credential };
}

describe("NetSuite compatibility proxy policy", () => {
  it("redacts transport details from action errors", async () => {
    const request = validateNetsuiteCredential(
      {
        accountId: "1234567",
        consumerKey: "consumer-key",
        consumerSecret: "consumer-secret",
        tokenId: "token-id",
        tokenSecret: "token-secret",
      },
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("socket failed at private-host with token secret");
      }),
    );
    await expect(request).rejects.toMatchObject({
      status: 502,
      message: "NetSuite request failed",
    });
  });

  it("rejects writes and non-allowlisted endpoints", async () => {
    await expect(
      proxy({ method: "POST", endpoint: "/services/rest/record/v1/customer" }, context()),
    ).resolves.toMatchObject({ ok: false, error: { details: { status: 403 } } });
    await expect(
      proxy({ method: "GET", endpoint: "/services/rest/query/v1/suiteql" }, context()),
    ).resolves.toMatchObject({ ok: false, error: { details: { status: 403 } } });
  });

  it("rejects unbounded pagination and company-scoped proxy use", async () => {
    await expect(
      proxy({ method: "GET", endpoint: "/services/rest/record/v1/customer", query: { limit: 201 } }, context()),
    ).resolves.toMatchObject({ ok: false, error: { details: { status: 400 } } });
    await expect(
      proxy(
        { method: "GET", endpoint: "/services/rest/record/v1/customer", query: { limit: 100, offset: 10_000 } },
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, error: { details: { status: 400 } } });
    await expect(
      proxy({ method: "GET", endpoint: "/services/rest/record/v1/customer" }, context({ companyId: "1" })),
    ).resolves.toMatchObject({ ok: false, error: { details: { status: 403 } } });
  });
});
