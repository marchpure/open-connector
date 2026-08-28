import type { ActionDefinition } from "../../core/types.ts";

import { s3CompatibleActions } from "../s3-compatible-profile.ts";

export const actions: ActionDefinition[] = s3CompatibleActions({
  service: "huawei_obs",
  displayName: "Huawei Cloud OBS",
  description: "",
  homepageUrl: "",
  endpointPlaceholder: "",
  endpointDescription: "",
  regionPlaceholder: "",
});
