import type { ProviderDefinition } from "../../core/types.ts";

import { dingtalkActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "dingtalk",
  displayName: "DingTalk",
  description:
    "User-authorized DingTalk enterprise context with explicit contact and identity reads. Custom bot webhooks remain a separate provider.",
  categories: ["Communication", "Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://login.dingtalk.com/oauth2/auth",
      tokenUrl: "https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
      scopes: ["openid", "Contact.User.Read", "Contact.Department.Read"],
      tokenEndpointAuthMethod: "client_secret_post",
      tokenRequestFormat: "json",
      clientSetup: {
        docsUrl: "https://open.dingtalk.com/document/orgapp/obtain-user-access-token",
        steps: [
          "Create a DingTalk internal application and configure this runtime's OAuth callback URL.",
          "Grant only the contact scopes needed by the actions enabled for this connection.",
        ],
      },
    },
  ],
  homepageUrl: "https://www.dingtalk.com",
  actions: dingtalkActions,
};
