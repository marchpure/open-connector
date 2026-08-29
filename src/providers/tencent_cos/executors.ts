import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { ProviderResourceCandidate } from "../provider-loader.ts";

import { cosSign, createNativeObjectStorageRuntime, nativeEndpoint } from "../native-object-storage-runtime.ts";

const profile = createNativeObjectStorageRuntime({
  service: "tencent_cos",
  displayName: "Tencent Cloud COS",
  bucketMimeType: "application/vnd.tencent.cos.bucket",
  listDialect: "v2",
  buildEndpoint: (values) =>
    nativeEndpoint(values.endpoint, `https://cos.${values.region}.myqcloud.com`, ["myqcloud.com"]),
  sign: cosSign,
});
export const executors: ProviderExecutors = profile.executors;
export const credentialValidators: CredentialValidators = profile.credentialValidators;
export const discoverResources: (
  context: import("../../core/types.ts").ExecutionContext,
  fetcher: typeof fetch,
) => Promise<ProviderResourceCandidate[]> = profile.discoverResources;
