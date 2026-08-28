import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { ProviderResourceCandidate } from "../provider-loader.ts";

import { defineErpVendorExecutors } from "../../core/erp/vendor-runtime.ts";
import { sapS4hanaVendor } from "../../core/erp/vendors.ts";

const runtime = defineErpVendorExecutors(sapS4hanaVendor);
export const executors: ProviderExecutors = runtime.executors;
export const credentialValidators: CredentialValidators = runtime.credentialValidators;
export const discoverResources: (
  context: ExecutionContext,
  fetcher: typeof fetch,
) => Promise<ProviderResourceCandidate[]> = runtime.discoverResources;
