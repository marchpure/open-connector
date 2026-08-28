import type { ExecutionContext, ResolvedCredential, TransitFileStore } from "../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../core/guarded-fetch.ts";
import { setPrivateNetworkAccessAllowed } from "../core/request.ts";
import { observeActionResources as observeBaiduNetdiskResources } from "./baidu_netdisk/executors.ts";
import { discoverResources as discoverHuaweiObsResources } from "./huawei_obs/executors.ts";
import { credentialValidators as huaweiObsValidators } from "./huawei_obs/executors.ts";
import { executors as huaweiObsExecutors } from "./huawei_obs/executors.ts";
import { executors as minioExecutors } from "./minio/executors.ts";
import { credentialValidators as minioValidators } from "./minio/executors.ts";
import { discoverResources as discoverMinioResources } from "./minio/executors.ts";
import { createMinioTlsFetch } from "./minio/tls-fetch.ts";
import { cosSign, obsSign } from "./native-object-storage-runtime.ts";
import { discoverResources as discoverQiniuKodoResources } from "./qiniu_kodo/executors.ts";
import { executors as qiniuKodoExecutors } from "./qiniu_kodo/executors.ts";
import { qiniuAuthorization } from "./qiniu_kodo/executors.ts";
import { actions as tencentCosActions } from "./tencent_cos/actions.ts";
import { discoverResources as discoverTencentCosResources } from "./tencent_cos/executors.ts";
import { provider as tencentDocsProvider } from "./tencent_docs/definition.ts";
import { credentialValidators as tencentDocsValidators } from "./tencent_docs/executors.ts";
import { discoverResources as discoverTencentDocsResources } from "./tencent_docs/executors.ts";
import { executors as tencentDocsExecutors } from "./tencent_docs/executors.ts";
import { observeActionResources as observeTencentDocsResources } from "./tencent_docs/executors.ts";
import { wpsMcpActions } from "./wps_mcp/actions.ts";
import { credentialValidators as wpsMcpValidators } from "./wps_mcp/executors.ts";
import { discoverResources as discoverWpsResources } from "./wps_mcp/executors.ts";
import { observeActionResources as observeWpsResources } from "./wps_mcp/executors.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tencentDocsCredential: Extract<ResolvedCredential, { authType: "oauth2" }> = {
  authType: "oauth2",
  accessToken: "user-token",
  tokenType: "Bearer",
  profile: { accountId: "open-user", displayName: "User", grantedScopes: [] },
  metadata: { clientId: "client-id", openID: "open-user" },
};
const wpsCredential: Extract<ResolvedCredential, { authType: "api_key" }> = {
  authType: "api_key",
  apiKey: "wps-token",
  values: { apiKey: "wps-token" },
  profile: { accountId: "wps-user", displayName: "WPS User", grantedScopes: [] },
  metadata: {},
};

describe("P2 CN office and storage discovery", () => {
  it("discovers bounded Tencent Docs files without leaking OAuth material", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("access-token")).toBe("user-token");
      return Response.json({
        ret: 0,
        msg: "Succeed",
        data: {
          next: null,
          list: [
            {
              ID: "doc-1",
              title: "Quarterly plan",
              type: "doc",
              ownerID: "owner-1",
              ownerName: "Ada",
              isOwner: false,
              lastModifyTime: 123,
              url: "https://docs.qq.com/doc/doc-1?access_token=must-not-leak#fragment",
              access_token: "must-not-leak",
            },
          ],
        },
      });
    });

    const resources = await discoverTencentDocsResources(contextFor("tencent_docs", tencentDocsCredential), fetcher);
    expect(resources).toEqual([
      expect.objectContaining({
        sourceType: "tencent_docs",
        resourceId: "doc-1",
        mimeType: "application/vnd.tencent-docs.doc",
        version: "123",
        owner: { id: "owner-1", displayName: "Ada" },
        aclSummary: { visibility: "shared" },
        url: "https://docs.qq.com/doc/doc-1",
      }),
    ]);
    expect(JSON.stringify(resources)).not.toContain("must-not-leak");
  });

  it("bounds Tencent Docs credential validation and propagates cancellation", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(`{"ret":0,"data":{"openID":"${"x".repeat(4 * 1024 * 1024)}"}}`);
    });

    await expect(
      tencentDocsValidators.oauth2!(tencentDocsCredential, {
        fetcher,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("reads a bounded Tencent Docs Smartsheet record page", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(new URL(request.url).pathname).toBe("/openapi/smartbook/v2/files/smart-1/sheets/sheet-1");
      expect(request.method).toBe("POST");
      expect(await request.json()).toEqual({ action: "getRecords", limit: 100, offset: 20 });
      return Response.json({
        ret: 0,
        msg: "Succeed",
        data: {
          records: Array.from({ length: 120 }, (_, index) => ({ recordId: `record-${index}`, fields: {} })),
          total: 140,
          hasMore: true,
        },
      });
    });

    const result = await tencentDocsExecutors["tencent_docs.get_smartsheet_records"]!(
      { fileID: "smart-1", sheetID: "sheet-1", limit: 100, offset: 20 },
      contextFor("tencent_docs", tencentDocsCredential),
    );

    expect(result).toMatchObject({
      ok: true,
      output: { total: 140, hasMore: true, offset: 20, raw: { bounded: true } },
    });
    expect(result.ok && (result.output as { records: unknown[] }).records).toHaveLength(100);
  });

  it("normalizes only provider-returned office list and search resources", () => {
    expect(
      observeTencentDocsResources("tencent_docs.search_files", {
        items: [{ ID: "doc-2", type: "doc", title: "Nested" }, { title: "missing id" }],
      }),
    ).toEqual([
      expect.objectContaining({
        sourceType: "tencent_docs",
        resourceId: "doc-2",
        mimeType: "application/vnd.tencent-docs.doc",
      }),
    ]);
    expect(
      observeTencentDocsResources("tencent_docs.list_smartsheet_sheets", {
        sheets: [{ sheetID: "sheet-2", title: "Tasks" }],
      }),
    ).toEqual([
      expect.objectContaining({
        resourceId: "sheet-2",
        mimeType: "application/vnd.tencent-docs.smartsheet.sheet",
      }),
    ]);
    expect(
      observeWpsResources("wps_mcp.list_files", {
        files: [{ file_id: "wps-2", file_type: "folder", name: "Nested" }],
      }),
    ).toEqual([
      expect.objectContaining({
        sourceType: "wps_mcp",
        resourceId: "wps-2",
        mimeType: "application/vnd.wps.folder",
      }),
    ]);
    expect(
      observeBaiduNetdiskResources("baidu_netdisk.semantic_search_files", {
        items: [{ id: "9007199254740993", path: "/nested.txt", kind: "file", name: "nested.txt" }],
      }),
    ).toEqual([
      expect.objectContaining({
        sourceType: "baidu_netdisk",
        resourceId: "9007199254740993",
        resourceToken: "/nested.txt",
      }),
    ]);
    expect(observeTencentDocsResources("tencent_docs.get_file_metadata", { items: [{ ID: "ignored" }] })).toEqual([]);
  });

  it("defaults Tencent Docs OAuth authorization to read-only provider scopes", () => {
    const auth = tencentDocsProvider.auth.find((entry) => entry.type === "oauth2");
    expect(auth?.defaultScopes).toEqual([
      "scope.user.info.base",
      "scope.drive.readonly",
      "scope.drive.file.metadata",
      "scope.drive.file.metadata.readonly",
      "scope.drive.exportable",
      "scope.doc.readonly",
      "scope.sheet.readonly",
      "scope.smartsheet.readonly",
    ]);
    expect(auth?.defaultScopes).not.toContain("scope.drive.creatable");
    expect(auth?.defaultScopes).not.toContain("scope.drive.editable");
    expect(auth?.defaultScopes).not.toContain("scope.form");
  });

  it("keeps WPS on the canonical MCP identity and binds content reads to discovery", () => {
    const read = wpsMcpActions.find((action) => action.name === "read_file");
    expect(read).toMatchObject({
      id: "wps_mcp.read_file",
      service: "wps_mcp",
      resourceBindings: { file_id: [] },
    });
    expect(read?.inputSchema).not.toHaveProperty("properties.url");
    expect(read?.inputSchema).not.toHaveProperty("properties.link_id");
    expect(read?.inputSchema).not.toHaveProperty("properties.enable_upload_medias");
  });

  it("rejects a WPS MCP token that is missing a required read tool", async () => {
    const fetcher = wpsToolListFetcher(["search_files", "list_my_files", "list_files", "get_file_info"]);

    await expect(
      wpsMcpValidators.apiKey!({ apiKey: "wps-token", values: { apiKey: "wps-token" } }, { fetcher }),
    ).rejects.toMatchObject({
      status: 403,
      message: "WPS MCP token is missing required read capability: read_file",
    });
  });

  it("grants WPS write capability only when a write tool is present", async () => {
    const readTools = ["search_files", "list_my_files", "list_files", "get_file_info", "read_file"];
    const readOnly = await wpsMcpValidators.apiKey!(
      { apiKey: "wps-token", values: { apiKey: "wps-token" } },
      { fetcher: wpsToolListFetcher(readTools) },
    );
    const withWrite = await wpsMcpValidators.apiKey!(
      { apiKey: "wps-token", values: { apiKey: "wps-token" } },
      { fetcher: wpsToolListFetcher([...readTools, "create_folder"]) },
    );

    expect(readOnly?.profile?.grantedScopes).toEqual([
      "wps_mcp.files.read",
      "wps_mcp.tools.inspect",
      "wps_mcp.tools.invoke",
    ]);
    expect(withWrite?.profile?.grantedScopes).toContain("wps_mcp.files.write");
  });

  it("discovers WPS files through an actual MCP initialize and tool-call exchange", async () => {
    const methods: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer wps-token");
      const message = JSON.parse(await request.clone().text()) as { id?: string | number; method: string };
      methods.push(message.method);
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "wps-fixture", version: "1" },
            }
          : {
              content: [],
              structuredContent: {
                items: [
                  {
                    file_id: "wps-file-1",
                    name: "Plan.docx",
                    file_type: "document",
                    version: "v3",
                    url: "https://www.kdocs.cn/l/file-1?token=must-not-leak#fragment",
                  },
                ],
              },
            };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    });

    const resources = await discoverWpsResources(contextFor("wps_mcp", wpsCredential), fetcher);

    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(resources).toEqual([
      expect.objectContaining({
        sourceType: "wps_mcp",
        resourceId: "wps-file-1",
        title: "Plan.docx",
        version: "v3",
        url: "https://www.kdocs.cn/l/file-1",
      }),
    ]);
    expect(JSON.stringify(resources)).not.toContain("must-not-leak");
  });

  for (const profile of [
    {
      service: "tencent_cos",
      endpoint: "https://cos.ap-guangzhou.myqcloud.com",
      discover: discoverTencentCosResources,
    },
    {
      service: "huawei_obs",
      endpoint: "https://obs.cn-north-4.myhuaweicloud.com",
      discover: discoverHuaweiObsResources,
    },
    {
      service: "qiniu_kodo",
      endpoint: "https://rsf.qiniu.com",
      discover: discoverQiniuKodoResources,
    },
  ] as const) {
    it(`discovers only the configured ${profile.service} bucket`, async () => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        profile.service === "qiniu_kodo"
          ? Response.json({ items: [], marker: "" })
          : new Response(null, { status: 200 }),
      );
      const credential = storageCredential(profile.endpoint, profile.service === "qiniu_kodo");
      const resources = await profile.discover(contextFor(profile.service, credential), fetcher);
      expect(resources).toEqual([
        expect.objectContaining({
          sourceType: profile.service,
          resourceId: "documents",
          schema: expect.objectContaining({ prefix: "knowledge/", allowlisted: true }),
        }),
      ]);
      const request = fetcher.mock.calls[0]?.[0];
      const url = new URL(request instanceof Request ? request.url : String(request));
      const headers = request instanceof Request ? request.headers : new Headers(fetcher.mock.calls[0]?.[1]?.headers);
      if (profile.service === "qiniu_kodo") {
        expect(url).toMatchObject({ hostname: "rsf.qiniu.com", pathname: "/list" });
        expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");
        expect(headers.get("authorization")).toMatch(/^Qiniu ACCESS_KEY:/u);
      } else {
        expect(url.hostname).toBe(`documents.${new URL(profile.endpoint).host}`);
        expect(headers.get("authorization")).toMatch(
          profile.service === "tencent_cos" ? /^q-sign-algorithm=sha1&/u : /^OBS ACCESS_KEY:/u,
        );
      }
    });
  }

  it("uses path-style addressing for MinIO and keeps the prefix boundary", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const resources = await discoverMinioResources(
      contextFor("minio", storageCredential("https://minio.example.com")),
      fetcher,
    );
    expect(resources).toEqual([
      expect.objectContaining({
        sourceType: "minio",
        resourceId: "documents",
        schema: expect.objectContaining({ prefix: "knowledge/" }),
      }),
    ]);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).pathname).toBe("/documents");
  });

  it("blocks cloud metadata endpoints even for opted-in MinIO deployments", async () => {
    setPrivateNetworkAccessAllowed(true);
    try {
      await expect(
        discoverMinioResources(
          contextFor("minio", storageCredential("https://169.254.169.254")),
          vi.fn<typeof fetch>(),
        ),
      ).rejects.toThrow(/metadata|private|reserved/i);
    } finally {
      setPrivateNetworkAccessAllowed(false);
    }
  });

  it("does not expose storage write, delete, or presign executors", () => {
    expect(Object.keys(minioExecutors).sort()).toEqual([
      "minio.download_object",
      "minio.head_object",
      "minio.list_buckets",
      "minio.list_objects",
    ]);
  });

  it("requires discovered bucket bindings for every object read", () => {
    expect(
      tencentCosActions
        .filter((action) => action.name !== "list_buckets")
        .map((action) => ({
          name: action.name,
          required: action.resourceBindings,
          optional: action.resourceBindingsOptional,
        })),
    ).toEqual([
      {
        name: "list_objects",
        required: { bucket: ["application/vnd.tencent.cos.bucket"] },
        optional: undefined,
      },
      {
        name: "head_object",
        required: { bucket: ["application/vnd.tencent.cos.bucket"] },
        optional: undefined,
      },
      {
        name: "download_object",
        required: { bucket: ["application/vnd.tencent.cos.bucket"] },
        optional: undefined,
      },
    ]);
  });

  it("matches the Tencent COS SDK authorization vector including the temporary token", () => {
    const request = new Request("https://documents.cos.ap-guangzhou.myqcloud.com/?list-type=2&prefix=knowledge%2F");
    cosSign(
      request,
      {
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        bucket: "documents",
        sessionToken: "TOKEN",
      },
      new Date(1_700_000_000_000),
    );
    expect(request.headers.get("authorization")).toBe(
      "q-sign-algorithm=sha1&q-ak=AKID&q-sign-time=1699999940;1700000900&q-key-time=1699999940;1700000900&q-header-list=host;x-cos-security-token&q-url-param-list=list-type;prefix&q-signature=6deff29821225b9c530177be28273f258cfd5660",
    );
  });

  it("matches the Huawei OBS canonical authorization vector with version and temporary token", () => {
    const request = new Request("https://documents.obs.cn-north-4.myhuaweicloud.com/knowledge%2Ffile.txt?versionId=v1");
    obsSign(
      request,
      {
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        bucket: "documents",
        sessionToken: "TOKEN",
      },
      new Date("2023-11-14T22:13:20Z"),
    );
    expect(request.headers.get("authorization")).toBe("OBS AKID:dr1cUJSdXHVtSZ+k2HrtA+mIGoo=");
    expect(request.headers.get("x-obs-security-token")).toBe("TOKEN");
  });

  it("matches the Qiniu SDK V2 authorization vector", () => {
    const url = new URL("https://rsf.qiniu.com/list?bucket=documents&limit=100&prefix=knowledge%2F");
    const headers = new Headers({ "x-qiniu-date": "20231114T221320Z" });
    expect(
      qiniuAuthorization(url, "POST", headers, {
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
      }),
    ).toBe("Qiniu AKID:0zZ7kBlL_1HBv_1dylTCCMSb6m4");
  });

  it("maps native OBS authorization errors without exposing the upstream body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response("<Error><Code>SignatureDoesNotMatch</Code><Message>secret detail</Message></Error>", {
            status: 403,
          }),
      ),
    );
    const result = await huaweiObsExecutors["huawei_obs.list_objects"]!(
      { bucket: "documents", prefix: "knowledge/" },
      contextFor("huawei_obs", storageCredential("https://obs.cn-north-4.myhuaweicloud.com")),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "authorization_failed",
        message: "Huawei Cloud OBS authorization failed: SignatureDoesNotMatch",
        details: { status: 403 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret detail");
  });

  it("rejects Qiniu prefix traversal before egress", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const result = await qiniuKodoExecutors["qiniu_kodo.list_objects"]!(
      { bucket: "documents", prefix: "private/" },
      contextFor("qiniu_kodo", storageCredential("https://rsf.qiniu.com", true)),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", details: { status: 403 } },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a Qiniu download when the object changes after stat even without caller ifMatch", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ hash: "etag-before", fsize: 4, mimeType: "text/plain" }))
      .mockResolvedValueOnce(new Response("data", { headers: { etag: '"etag-after"', "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", fetcher);
    const create = vi.fn<TransitFileStore["create"]>();
    const result = await qiniuKodoExecutors["qiniu_kodo.download_object"]!(
      { bucket: "documents", objectKey: "knowledge/file.txt" },
      {
        ...contextFor("qiniu_kodo", storageCredential("https://rsf.qiniu.com", true)),
        transitFiles: transitFiles(1024, create),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { status: 412 } },
    });
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("if-match")).toBe("etag-before");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects unsafe Qiniu download MIME before writing a transit file", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ hash: "etag", fsize: 4, mimeType: "text/html" }))
      .mockResolvedValueOnce(new Response("<x/>", { headers: { etag: "etag", "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetcher);
    const create = vi.fn<TransitFileStore["create"]>();
    const result = await qiniuKodoExecutors["qiniu_kodo.download_object"]!(
      { bucket: "documents", objectKey: "knowledge/file.html" },
      {
        ...contextFor("qiniu_kodo", storageCredential("https://rsf.qiniu.com", true)),
        transitFiles: transitFiles(1024, create),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { status: 415 } },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects oversized Qiniu downloads before writing a transit file", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ hash: "etag", fsize: 2048, mimeType: "text/plain" }))
      .mockResolvedValueOnce(
        new Response("data", {
          headers: { etag: "etag", "content-length": "2048", "content-type": "text/plain" },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const create = vi.fn<TransitFileStore["create"]>();
    const result = await qiniuKodoExecutors["qiniu_kodo.download_object"]!(
      { bucket: "documents", objectKey: "knowledge/file.txt" },
      {
        ...contextFor("qiniu_kodo", storageCredential("https://rsf.qiniu.com", true)),
        transitFiles: transitFiles(1024, create),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { status: 413 } },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("maps Qiniu errors without returning provider secrets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({ code: "secret-detail-in-code", error: "invalid token secret-detail" }, { status: 401 }),
      ),
    );
    const result = await qiniuKodoExecutors["qiniu_kodo.list_objects"]!(
      { bucket: "documents", prefix: "knowledge/" },
      contextFor("qiniu_kodo", storageCredential("https://rsf.qiniu.com", true)),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "authorization_failed", details: { status: 401 } },
    });
    expect(JSON.stringify(result)).not.toContain("secret-detail");
  });

  it("keeps safe numeric Qiniu provider codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => Response.json({ code: 631, error: "bucket missing" }, { status: 404 })),
    );
    const result = await qiniuKodoExecutors["qiniu_kodo.list_objects"]!(
      { bucket: "documents", prefix: "knowledge/" },
      contextFor("qiniu_kodo", storageCredential("https://rsf.qiniu.com", true)),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Qiniu Kodo request failed (631)", details: { status: 404 } },
    });
    expect(JSON.stringify(result)).not.toContain("bucket missing");
  });

  it("rejects invalid MinIO custom CA material", async () => {
    await expect(createMinioTlsFetch("not a certificate")).rejects.toThrow(/valid PEM-encoded X.509/u);
  });

  it("times out native storage credential validation", async () => {
    vi.useFakeTimers();
    setDefaultGuardedFetchDnsLookup(null);
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = _input instanceof Request ? _input.signal : init?.signal;
          signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")), {
            once: true,
          });
        }),
    );
    const validation = huaweiObsValidators.customCredential!(
      { values: storageCredential("https://obs.cn-north-4.myhuaweicloud.com").values },
      { fetcher },
    );
    const rejection = expect(validation).rejects.toMatchObject({ status: 504 });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    } finally {
      setDefaultGuardedFetchDnsLookup(undefined);
    }
  });

  it("times out MinIO credential validation across its bucket fallback", async () => {
    vi.useFakeTimers();
    setDefaultGuardedFetchDnsLookup(null);
    setPrivateNetworkAccessAllowed(true);
    const fetcher = vi.fn<typeof fetch>(
      async (input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = input instanceof Request ? input.signal : init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")), {
            once: true,
          });
        }),
    );
    const validation = minioValidators.customCredential!(
      {
        values: storageCredential("https://minio.example.com").values,
      },
      { fetcher },
    );
    const rejection = expect(validation).rejects.toMatchObject({ status: 504 });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    } finally {
      setDefaultGuardedFetchDnsLookup(undefined);
      setPrivateNetworkAccessAllowed(false);
    }
  });
});

function storageCredential(
  endpoint: string,
  qiniu = false,
): Extract<ResolvedCredential, { authType: "custom_credential" }> {
  return {
    authType: "custom_credential",
    values: {
      accessKeyId: "ACCESS_KEY",
      secretAccessKey: "secret",
      region: "cn-region-1",
      endpoint,
      ...(qiniu ? { downloadDomain: "https://downloads.example.com" } : {}),
      bucket: "documents",
      prefix: "knowledge/",
    },
    profile: { accountId: "ACCESS_KEY", displayName: "Storage", grantedScopes: [] },
    metadata: { endpoint, bucket: "documents", prefix: "knowledge/" },
  };
}

function contextFor(service: string, credential: ResolvedCredential): ExecutionContext {
  return {
    getCredential: async (requestedService) => {
      expect(requestedService).toBe(service);
      return credential;
    },
  };
}

function wpsToolListFetcher(toolNames: string[]): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const message = JSON.parse(await request.clone().text()) as { id?: string | number; method: string };
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "wps-fixture", version: "1" },
          }
        : {
            tools: toolNames.map((name) => ({
              name,
              description: `${name} fixture`,
              inputSchema: { type: "object", properties: {} },
            })),
          };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  });
}

function transitFiles(maxBytes: number, create: TransitFileStore["create"]): TransitFileStore {
  return {
    maxBytes,
    create,
    read: vi.fn<TransitFileStore["read"]>(),
    delete: vi.fn<TransitFileStore["delete"]>(),
  };
}
