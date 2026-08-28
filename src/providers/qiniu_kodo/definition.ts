import type { ProviderDefinition } from "../../core/types.ts";

import { s3CompatibleDefinition } from "../s3-compatible-profile.ts";

export const provider: ProviderDefinition = s3CompatibleDefinition({
  service: "qiniu_kodo",
  displayName: "Qiniu Kodo",
  description:
    "Read bounded objects from an allowlisted Qiniu Kodo bucket through its official S3-compatible endpoint.",
  homepageUrl: "https://www.qiniu.com/products/kodo",
  endpointPlaceholder: "https://s3-cn-east-1.qiniucs.com",
  endpointDescription: "Official regional Kodo S3 endpoint.",
  regionPlaceholder: "cn-east-1",
});
