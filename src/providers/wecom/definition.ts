import type { ProviderDefinition } from "../../core/types.ts";

import { wecomActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "wecom",
  displayName: "WeCom",
  description:
    "Enterprise-app WeCom context with explicit corp identity, directory, and allowlisted group reads. Bot and MCP integrations remain separate.",
  categories: ["Communication", "Productivity"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        { key: "corpId", label: "Corp ID", inputType: "text", required: true, secret: false },
        { key: "agentId", label: "Agent ID", inputType: "text", required: true, secret: false },
        { key: "secret", label: "Application Secret", inputType: "password", required: true, secret: true },
        {
          key: "departmentId",
          label: "Directory Root",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "1",
        },
      ],
    },
  ],
  homepageUrl: "https://work.weixin.qq.com",
  actions: wecomActions,
};
