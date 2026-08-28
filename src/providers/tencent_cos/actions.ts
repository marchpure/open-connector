import type { ActionDefinition } from "../../core/types.ts";

import { s3CompatibleActions } from "../s3-compatible-profile.ts";

export const actions: ActionDefinition[] = s3CompatibleActions({
  service: "tencent_cos",
  displayName: "Tencent Cloud COS",
  description: "",
  homepageUrl: "",
  endpointPlaceholder: "",
  endpointDescription: "",
  regionPlaceholder: "",
});
