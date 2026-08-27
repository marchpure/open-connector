import { describe, expect, it, vi } from "vitest";
import { RestAdapterError, RestOpenApiAdapter } from "./rest-adapter.ts";

const spec = {
  info: { version: "1" },
  paths: {
    "/records": {
      get: { operationId: "listRecords", responses: { "200": {} } },
      post: { operationId: "createRecord", requestBody: {}, responses: { "201": {} } },
    },
  },
};

describe("RestOpenApiAdapter", () => {
  it("requires confirmation without a spec and idempotency for writes", async () => {
    expect(() => RestOpenApiAdapter.fromSpec("https://example.com", undefined, { type: "none" }, false)).toThrowError(
      new RestAdapterError("confirmation_required", "Endpoint, method, and schema require explicit user confirmation when no spec is provided."),
    );
    const adapter = RestOpenApiAdapter.fromSpec("https://example.com", spec, { type: "none" }, true, vi.fn(async () => Response.json({ ok: true }, { status: 201 })) as typeof fetch);
    await expect(adapter.invoke({ operationId: "createRecord", body: {}, confirmed: true })).rejects.toMatchObject({ code: "idempotency_required" });
  });

  it("uses the confirmed operation, auth header, guarded fetch, and idempotency replay", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
      return Response.json({ id: 1 }, { status: 200 });
    }) as typeof fetch;
    const adapter = RestOpenApiAdapter.fromSpec("https://api.example.com", spec, { type: "bearer", token: "token" }, true, fetcher);
    const first = await adapter.invoke({ operationId: "createRecord", body: { name: "x" }, confirmed: true, idempotencyKey: "k1" });
    const second = await adapter.invoke({ operationId: "createRecord", body: { name: "x" }, confirmed: true, idempotencyKey: "k1" });
    expect(first).toEqual(second);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
