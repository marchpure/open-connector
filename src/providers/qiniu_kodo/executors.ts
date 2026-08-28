import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { ProviderResourceCandidate } from "../provider-loader.ts";

import { createS3CompatibleExecutors } from "../aws_s3/executors.ts";

const profile = createS3CompatibleExecutors({
  service: "qiniu_kodo",
  displayName: "Qiniu Kodo",
  defaultEndpoint: (values) => (values.region ? `https://s3-${values.region}.qiniucs.com` : undefined),
});
export const executors: ProviderExecutors = profile.executors;
export const credentialValidators: CredentialValidators = profile.credentialValidators;
export const discoverResources: (
  context: import("../../core/types.ts").ExecutionContext,
  fetcher: typeof fetch,
) => Promise<ProviderResourceCandidate[]> = profile.discoverResources;
