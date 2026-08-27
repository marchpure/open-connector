import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { RestAdapterError, RestIdempotencyStore, RestOpenApiAdapter } from "./rest-adapter.ts";

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
      new RestAdapterError(
        "confirmation_required",
        "Endpoint, method, and schema require explicit user confirmation when no spec is provided.",
      ),
    );
    const adapter = RestOpenApiAdapter.fromSpec(
      "https://example.com",
      spec,
      { type: "none" },
      true,
      vi.fn(async () => Response.json({ ok: true }, { status: 201 })) as typeof fetch,
    );
    await expect(adapter.invoke({ operationId: "createRecord", body: {}, confirmed: true })).rejects.toMatchObject({
      code: "idempotency_required",
    });
  });

  it("uses the confirmed operation, auth header, guarded fetch, and idempotency replay", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
      return Response.json({ id: 1 }, { status: 200 });
    }) as typeof fetch;
    const adapter = RestOpenApiAdapter.fromSpec(
      "https://api.example.com",
      spec,
      { type: "bearer", token: "token" },
      true,
      fetcher,
    );
    const first = await adapter.invoke({
      operationId: "createRecord",
      body: { name: "x" },
      confirmed: true,
      idempotencyKey: "k1",
    });
    const second = await adapter.invoke({
      operationId: "createRecord",
      body: { name: "x" },
      confirmed: true,
      idempotencyKey: "k1",
    });
    expect(first).toEqual(second);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("replays idempotent writes after adapter recreation and isolates tenant keys", async () => {
    const database = new DatabaseSync(":memory:");
    const codec = new AesGcmSecretCodec("rest-idempotency-key");
    const fetcher = vi.fn(async () => Response.json({ id: 1 }, { status: 201 })) as typeof fetch;
    const create = (tenantId: string) =>
      RestOpenApiAdapter.fromSpec(
        "https://api.example.com",
        spec,
        { type: "none" },
        true,
        fetcher,
        new RestIdempotencyStore(database, { tenantId, workspaceId: "workspace-a" }, codec),
      );
    const input = {
      operationId: "createRecord",
      body: { name: "x" },
      confirmed: true,
      idempotencyKey: "stable-key",
    };

    expect(await create("tenant-a").invoke(input)).toMatchObject({ data: { id: 1 } });
    expect(await create("tenant-a").invoke(input)).toMatchObject({ data: { id: 1 } });
    await expect(create("tenant-a").invoke({ ...input, body: { name: "different" } })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(await create("tenant-b").invoke(input)).toMatchObject({ data: { id: 1 } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(database.prepare("select * from rest_idempotency").all())).not.toContain("stable-key");
    database.close();
  });
});
