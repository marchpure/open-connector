import type { ProviderDefinition } from "../../core/types.ts";

import { maxcomputeActions } from "./actions.ts";

export const nodeOnly = true;

export const provider: ProviderDefinition = {
  service: "maxcompute",
  displayName: "MaxCompute",
  categories: ["Data", "Developer Tools"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "endpoint",
          label: "API endpoint",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "https://maxcompute.cn-hangzhou.aliyuncs.com",
        },
        {
          key: "regionId",
          label: "Region ID",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "cn-hangzhou",
        },
        {
          key: "project",
          label: "Default project",
          inputType: "text",
          required: true,
          secret: false,
        },
        {
          key: "accessKeyId",
          label: "AccessKey ID",
          inputType: "text",
          required: true,
          secret: false,
        },
        {
          key: "accessKeySecret",
          label: "AccessKey secret",
          inputType: "password",
          required: true,
          secret: true,
        },
        {
          key: "securityToken",
          label: "STS security token",
          inputType: "password",
          required: false,
          secret: true,
        },
      ],
      testAction: { actionName: "validate_connection", input: {} },
    },
  ],
  homepageUrl: "https://www.alibabacloud.com/product/maxcompute",
  actions: maxcomputeActions,
};
