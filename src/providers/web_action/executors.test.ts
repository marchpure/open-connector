import { describe, expect, it, vi } from "vitest";
import { executors } from "./executors.ts";

describe("Web Action provider", () => {
  it("fetches JSON through the provider action contract", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }, { headers: { "x-trace": "trace-1" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      executors["web_action.fetch_json"]!(
        { url: "https://example.com/data.json" },
        { getCredential: async () => ({ authType: "no_auth" }) },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        status: 200,
        data: { ok: true },
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/data.json",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("rejects credential-bearing request headers", async () => {
    await expect(
      executors["web_action.fetch_json"]!(
        {
          url: "https://example.com/data.json",
          headers: { authorization: "Bearer secret" },
        },
        { getCredential: async () => ({ authType: "no_auth" }) },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "authorization header is not allowed.",
      },
    });
  });
});
