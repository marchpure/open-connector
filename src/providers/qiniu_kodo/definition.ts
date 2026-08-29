import type { ProviderDefinition } from "../../core/types.ts";

import { s3CompatibleDefinition } from "../s3-compatible-profile.ts";

export const provider: ProviderDefinition = s3CompatibleDefinition({
  service: "qiniu_kodo",
  displayName: "Qiniu Kodo",
  description: "Read bounded objects from an allowlisted Qiniu Kodo bucket using native Kodo APIs and signing.",
  homepageUrl: "https://www.qiniu.com/products/kodo",
  endpointPlaceholder: "https://rsf.qiniu.com",
  endpointDescription: "Official regional Qiniu RSF management endpoint.",
  regionPlaceholder: "cn-east-1",
  supportsSessionToken: false,
});
