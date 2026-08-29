import type { ProviderDefinition } from "../../core/types.ts";

import { s3CompatibleDefinition } from "../s3-compatible-profile.ts";

export const provider: ProviderDefinition = s3CompatibleDefinition({
  service: "tencent_cos",
  displayName: "Tencent Cloud COS",
  description: "Read bounded objects from an allowlisted Tencent Cloud COS bucket using native COS signing.",
  homepageUrl: "https://cloud.tencent.com/product/cos",
  endpointPlaceholder: "https://cos.ap-guangzhou.myqcloud.com",
  endpointDescription: "Official regional COS endpoint.",
  regionPlaceholder: "ap-guangzhou",
});
