import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { ProviderResourceCandidate } from "../provider-loader.ts";

import { createNativeObjectStorageRuntime, nativeEndpoint, obsSign } from "../native-object-storage-runtime.ts";

const profile = createNativeObjectStorageRuntime({
  service: "huawei_obs",
  displayName: "Huawei Cloud OBS",
  bucketMimeType: "application/vnd.huawei.obs.bucket",
  listDialect: "marker",
  buildEndpoint: (values) =>
    nativeEndpoint(values.endpoint, `https://obs.${values.region}.myhuaweicloud.com`, ["myhuaweicloud.com"]),
  sign: obsSign,
});
export const executors: ProviderExecutors = profile.executors;
export const credentialValidators: CredentialValidators = profile.credentialValidators;
export const discoverResources: (
  context: import("../../core/types.ts").ExecutionContext,
  fetcher: typeof fetch,
) => Promise<ProviderResourceCandidate[]> = profile.discoverResources;
