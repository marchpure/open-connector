import type { ProviderDefinition } from "../../core/types.ts";

import { s3CompatibleDefinition } from "../s3-compatible-profile.ts";

export const provider: ProviderDefinition = s3CompatibleDefinition({
  service: "huawei_obs",
  displayName: "Huawei Cloud OBS",
  description: "Read bounded objects from an allowlisted Huawei Cloud OBS bucket through its S3-compatible API.",
  homepageUrl: "https://www.huaweicloud.com/product/obs.html",
  endpointPlaceholder: "https://obs.cn-north-4.myhuaweicloud.com",
  endpointDescription: "Official regional OBS endpoint.",
  regionPlaceholder: "cn-north-4",
});
