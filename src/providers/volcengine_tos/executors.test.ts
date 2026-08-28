import type { ExecutionContext, ResolvedCredential, TransitFileStore } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { executors } from "./executors.ts";

const credential: Extract<ResolvedCredential, { authType: "custom_credential" }> = {
  authType: "custom_credential",
  values: {
    accessKeyId: "AKLTEXAMPLE",
    secretAccessKey: "secret-example",
    region: "cn-beijing",
    endpoint: "https://tos-cn-beijing.volces.com",
    bucket: "documents",
    prefix: "knowledge/",
  },
  profile: { accountId: "AKLTEXAMPLE", displayName: "TOS test", grantedScopes: [] },
  metadata: {
    region: "cn-beijing",
    endpoint: "https://tos-cn-beijing.volces.com",
    bucket: "documents",
    prefix: "knowledge/",
  },
};

beforeEach(() => setDefaultGuardedFetchDnsLookup(null));
afterEach(() => {
  vi.useRealTimers();
  setDefaultGuardedFetchDnsLookup(undefined);
  vi.unstubAllGlobals();
});

describe("Volcengine TOS", () => {
  it("matches the deterministic official-style Signature V4 request vector", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init));
      return new Response(null, { status: 200 });
    });

    const result = await run("volcengine_tos.validate_connection", {});

    expect(result).toMatchObject({ ok: true });
    expect(requests[0]?.headers.get("authorization")).toBe(
      "TOS4-HMAC-SHA256 Credential=AKLTEXAMPLE/20240101/cn-beijing/tos/request, " +
        "SignedHeaders=host;user-agent;x-tos-content-sha256;x-tos-date, " +
        "Signature=5c48694940064c84aa89191502176484c92104af8b115ca4425ac4054010c383",
    );
    vi.useRealTimers();
  });

  it("rejects a bucket outside the connection allowlist before egress", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const result = await run("volcengine_tos.list_objects", { bucket: "other-bucket" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", message: "bucket is outside the TOS connection allowlist" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an object key outside the prefix allowlist before egress", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const result = await run("volcengine_tos.head_object", { objectKey: "private/secret.txt" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", message: "objectKey is outside the TOS connection allowlist" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed bucket and key values before egress", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const invalidBucket = await run("volcengine_tos.list_objects", { bucket: "bucket.example#" });
    const invalidKey = await run("volcengine_tos.head_object", { objectKey: "knowledge/\u0000secret" });

    expect(invalidBucket).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "bucket must be a valid TOS bucket name" },
    });
    expect(invalidKey).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: "objectKey contains an unsafe control character" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("streams and bounds object downloads without storing partial data", async () => {
    const content = new Uint8Array([84, 79, 83, 0, 255]);
    const create = vi.fn<TransitFileStore["create"]>(async (file) => ({
      fileId: "tos-file",
      downloadUrl: "http://localhost/files/tos-file",
      sizeBytes: file.size,
      name: file.name,
      mimeType: file.type,
    }));
    const transit: TransitFileStore = {
      maxBytes: 1024,
      create,
      async read() {
        throw new Error("not used");
      },
      async delete() {
        return false;
      },
    };
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init));
      return new Response(content, {
        headers: { "content-type": "application/octet-stream", etag: '"tos-etag"', "x-tos-version-id": "v1" },
      });
    });

    const result = await run("volcengine_tos.download_object", { objectKey: "knowledge/report.bin" }, transit);

    expect(result).toMatchObject({
      ok: true,
      output: {
        objectKey: "knowledge/report.bin",
        sizeBytes: content.length,
        etag: '"tos-etag"',
        versionId: "v1",
      },
    });
    expect(new URL(requests[0]!.url).hostname).toBe("documents.tos-cn-beijing.volces.com");
    expect(requests[0]?.headers.get("authorization")).toMatch(/^TOS4-HMAC-SHA256 Credential=AKLTEXAMPLE\//);
    expect(new Uint8Array(await create.mock.calls[0]![0].arrayBuffer())).toEqual(content);
  });

  it("rejects reserved endpoints before transport", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const context: ExecutionContext = {
      getCredential: async () => ({
        ...credential,
        values: { ...credential.values, endpoint: "https://169.254.169.254" },
      }),
    };

    const result = await executors["volcengine_tos.validate_connection"]!({}, context);

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function run(
  action:
    | "volcengine_tos.validate_connection"
    | "volcengine_tos.list_objects"
    | "volcengine_tos.head_object"
    | "volcengine_tos.download_object",
  input: Record<string, unknown>,
  transitFiles?: TransitFileStore,
) {
  const context: ExecutionContext = {
    getCredential: async (service) => {
      expect(service).toBe("volcengine_tos");
      return credential;
    },
    transitFiles,
  };
  return executors[action]!(input, context);
}
