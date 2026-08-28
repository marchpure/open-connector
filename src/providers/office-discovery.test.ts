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
      const body = (await request.json()) as { page_token?: string };
      const pageToken = body.page_token;
      return new Response(
        JSON.stringify({
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
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const resources = await discoverFeishuResources(contextFor("feishu", oauthCredential), fetcher);

    expect(resources).toHaveLength(2);
    expect(resources[0]).toMatchObject({
      sourceType: "feishu",
      resourceId: "doc-1",
      resourceToken: "wiki-token-1",
      title: "First",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[1]?.body).toContain('"page_token":"page-2"');
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
