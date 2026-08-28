import type { ExecutionContext, ResolvedCredential } from "../core/types.ts";

import { describe, expect, it, vi } from "vitest";
import { setPrivateNetworkAccessAllowed } from "../core/request.ts";
import { discoverResources as discoverHuaweiObsResources } from "./huawei_obs/executors.ts";
import { executors as minioExecutors } from "./minio/executors.ts";
import { discoverResources as discoverMinioResources } from "./minio/executors.ts";
import { discoverResources as discoverQiniuKodoResources } from "./qiniu_kodo/executors.ts";
import { discoverResources as discoverTencentCosResources } from "./tencent_cos/executors.ts";
import { discoverResources as discoverTencentDocsResources } from "./tencent_docs/executors.ts";
import { wpsMcpActions } from "./wps_mcp/actions.ts";

const tencentDocsCredential: Extract<ResolvedCredential, { authType: "oauth2" }> = {
  authType: "oauth2",
  accessToken: "user-token",
  tokenType: "Bearer",
  profile: { accountId: "open-user", displayName: "User", grantedScopes: [] },
  metadata: { clientId: "client-id", openID: "open-user" },
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
              url: "https://docs.qq.com/doc/doc-1",
              ownerID: "owner-1",
              ownerName: "Ada",
              isOwner: false,
              lastModifyTime: 123,
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
      }),
    ]);
    expect(JSON.stringify(resources)).not.toContain("must-not-leak");
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
