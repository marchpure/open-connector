import type { ProviderDefinition } from "../../core/types.ts";

import { dingtalkActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "dingtalk",
  displayName: "DingTalk",
  description:
    "User-authorized DingTalk enterprise context with bounded contact, calendar, and todo reads. Custom bot webhooks and enterprise-application identities remain separate.",
  categories: ["Communication", "Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://login.dingtalk.com/oauth2/auth",
      tokenUrl: "https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
      scopes: ["openid", "Contact.User.Read", "Contact.Department.Read", "Calendar.Calendar.Read", "Todo.Todo.Read"],
      minimumScopes: ["openid"],
      tokenEndpointAuthMethod: "client_secret_post",
      tokenRequestFormat: "json",
      clientSetup: {
        docsUrl: "https://open.dingtalk.com/document/orgapp/obtain-user-access-token",
        steps: [
          "Create a DingTalk internal application and configure this runtime's OAuth callback URL.",
          "Grant only the user scopes needed by the actions enabled for this connection.",
          "Do not substitute an enterprise access token or custom-bot webhook token for this user OAuth connection.",
        ],
      },
    },
  ],
  homepageUrl: "https://www.dingtalk.com",
  actions: dingtalkActions,
};
