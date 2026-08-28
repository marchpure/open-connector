import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { ProviderResourceCandidate } from "../provider-loader.ts";

import { createS3CompatibleExecutors } from "../aws_s3/executors.ts";

const profile = createS3CompatibleExecutors({
  service: "tencent_cos",
  displayName: "Tencent Cloud COS",
  defaultEndpoint: (values) => (values.region ? `https://cos.${values.region}.myqcloud.com` : undefined),
});
export const executors: ProviderExecutors = profile.executors;
export const credentialValidators: CredentialValidators = profile.credentialValidators;
export const discoverResources: (
  context: import("../../core/types.ts").ExecutionContext,
  fetcher: typeof fetch,
) => Promise<ProviderResourceCandidate[]> = profile.discoverResources;
