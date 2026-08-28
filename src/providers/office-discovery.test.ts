import type { ExecutionContext, ResolvedCredential } from "../core/types.ts";

import { describe, expect, it, vi } from "vitest";
import { discoverResources as discoverDingTalkResources } from "./dingtalk/executors.ts";
import { dingtalkActionHandlers } from "./dingtalk/executors.ts";
import { discoverResources as discoverFeishuResources } from "./feishu/executors.ts";
import { discoverResources as discoverWeComResources } from "./wecom/executors.ts";
import { wecomActionHandlers } from "./wecom/executors.ts";

const oauthCredential: Extract<ResolvedCredential, { authType: "oauth2" }> = {
  authType: "oauth2",
  accessToken: "user-token",
  tokenType: "Bearer",
  profile: { accountId: "user-1", displayName: "User", grantedScopes: [] },
  metadata: {},
};

const wecomCredential: Extract<ResolvedCredential, { authType: "custom_credential" }> = {
  authType: "custom_credential",
  values: { corpId: "corp-1", agentId: "agent-1", secret: "secret" },
  profile: { accountId: "corp-1", displayName: "WeCom", grantedScopes: [] },
  metadata: {},
};

describe("office provider resource discovery", () => {
  it("paginates Feishu document/Wiki resources and stops at the bounded page budget", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/authen/v1/user_info")) {
        return Response.json({ code: 0, data: { open_id: "user-1" } });
      }
      if (url.pathname.endsWith("/search/v2/doc_wiki/search")) {
        const body = (await request.json()) as { page_token?: string };
        const pageToken = body.page_token;
        return Response.json({
          code: 0,
          data: {
            res_units: [
              {
                document_id: pageToken ? "doc-2" : "doc-1",
                obj_token: pageToken ? "wiki-token-2" : "wiki-token-1",
                title: pageToken ? "Second" : "First",
                obj_type: "docx",
              },
            ],
            has_more: true,
            page_token: pageToken ? "page-3" : "page-2",
          },
        });
      }
      if (url.pathname.endsWith("/drive/v1/files")) {
        return Response.json({ code: 0, data: { files: [{ token: "drive-file-1", name: "Report" }] } });
      }
      if (url.pathname.endsWith("/wiki/v2/spaces")) {
        return Response.json({
          code: 0,
          data: { items: [{ space_id: "space-1", name: "Knowledge" }], has_more: false },
        });
      }
      if (url.pathname.endsWith("/wiki/v2/spaces/space-1/nodes")) {
        return Response.json({
          code: 0,
          data: { items: [{ node_token: "node-1", title: "Node" }], has_more: false },
        });
      }
      if (url.pathname.endsWith("/im/v1/chats")) {
        return Response.json({
          code: 0,
          data: { items: [{ chat_id: "chat-1", name: "Team" }], has_more: false },
        });
      }
      if (url.pathname.endsWith("/minutes/v1/minutes/search")) {
        return Response.json({
          code: 0,
          data: { items: [{ minute_token: "minute-1", topic: "Weekly" }], has_more: false },
        });
      }
      throw new Error(`unexpected Feishu discovery URL: ${url.pathname}`);
    });

    const resources = await discoverFeishuResources(contextFor("feishu", oauthCredential), fetcher);

    expect(resources).toHaveLength(7);
    expect(resources[0]).toMatchObject({
      sourceType: "feishu",
      resourceId: "doc-1",
      resourceToken: "wiki-token-1",
      title: "First",
    });
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: "drive-file-1", title: "Report" }),
        expect.objectContaining({ resourceId: "space-1", mimeType: "application/vnd.feishu.wiki-space" }),
        expect.objectContaining({ resourceId: "node-1", mimeType: "application/vnd.feishu.wiki-node" }),
        expect.objectContaining({ resourceId: "chat-1", mimeType: "application/vnd.feishu.chat" }),
        expect.objectContaining({ resourceId: "minute-1", mimeType: "application/vnd.feishu.minutes" }),
      ]),
    );
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('"page_token":"page-2"');
  });

  it("discovers bounded DingTalk directory ResourceRefs", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/users/me")) {
        return Response.json({ userId: "user-1", nick: "Ada" });
      }
      if (url.pathname.endsWith("/users/search")) {
        return Response.json({ users: [{ userId: "user-2", name: "Grace" }], hasMore: false });
      }
      return Response.json({
        departments: [
          {
            deptId: "dept-1",
            name: "Engineering",
            description: "A".repeat(20_000),
            access_token: "must-not-enter-resource-schema",
          },
        ],
        hasMore: false,
      });
    });
    await expect(discoverDingTalkResources(contextFor("dingtalk", oauthCredential), fetcher)).resolves.toEqual([
      expect.objectContaining({
        resourceId: "user-1",
        title: "Ada",
        mimeType: "application/vnd.dingtalk.user",
      }),
      expect.objectContaining({ resourceId: "user-2", mimeType: "application/vnd.dingtalk.user" }),
      expect.objectContaining({
        resourceId: "dept-1",
        title: "Engineering",
        mimeType: "application/vnd.dingtalk.department",
        schema: { deptId: "dept-1", name: "Engineering", description: expect.stringContaining("[truncated]") },
      }),
    ]);
  });

  it("discovers WeCom directory ResourceRefs after token authorization", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/gettoken")) return Response.json({ errcode: 0, access_token: "access-token" });
      return Response.json({ errcode: 0, department: [{ id: 1, name: "Engineering", name_en: "Engineering" }] });
    });

    await expect(discoverWeComResources(contextFor("wecom", wecomCredential), fetcher)).resolves.toEqual([
      expect.objectContaining({
        resourceId: "1",
        title: "Engineering",
        mimeType: "application/vnd.wecom.department",
      }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds and redacts DingTalk action list results", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ users: Array.from({ length: 150 }, (_, index) => ({ id: index, token: "secret" })) }),
    );
    const result = await dingtalkActionHandlers.search_users(
      { query: "engineering", size: 100 },
      { accessToken: "token", tokenType: "Bearer", fetcher },
    );
    expect(result).toMatchObject({ items: expect.any(Array) });
    expect((result as { items: unknown[] }).items).toHaveLength(100);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("bounds and redacts WeCom directory action results", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/gettoken")) return Response.json({ errcode: 0, access_token: "access-token" });
      return Response.json({
        errcode: 0,
        userlist: Array.from({ length: 1100 }, (_, index) => ({ userid: String(index), secret: "secret" })),
      });
    });
    const result = await wecomActionHandlers.list_users(
      { departmentId: "1", fetchChild: false },
      { values: { corpId: "corp-1", agentId: "agent-1", secret: "secret" }, fetcher },
    );
    expect(result).toMatchObject({ total: 1000, items: expect.any(Array) });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

function contextFor(service: string, credential: ResolvedCredential): ExecutionContext {
  return {
    getCredential: async (requestedService) => {
      expect(requestedService).toBe(service);
      return credential;
    },
  };
}
