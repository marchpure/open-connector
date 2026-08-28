import type { ExecutionContext, ResolvedCredential } from "../core/types.ts";

import { describe, expect, it, vi } from "vitest";
import { discoverResources as discoverDingTalkResources } from "./dingtalk/executors.ts";
import { discoverResources as discoverFeishuResources } from "./feishu/executors.ts";
import { discoverResources as discoverWeComResources } from "./wecom/executors.ts";

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

  it("does not turn DingTalk identity data into knowledge resources", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ userId: "user-1", nick: "User" }), {
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(discoverDingTalkResources(contextFor("dingtalk", oauthCredential), fetcher)).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not turn WeCom department data into knowledge resources", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(discoverWeComResources(contextFor("wecom", wecomCredential), fetcher)).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
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
