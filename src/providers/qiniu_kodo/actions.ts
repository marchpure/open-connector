import type { ActionDefinition } from "../../core/types.ts";

import { s3CompatibleActions } from "../s3-compatible-profile.ts";

export const actions: ActionDefinition[] = s3CompatibleActions({
  service: "qiniu_kodo",
  displayName: "Qiniu Kodo",
  description: "",
  homepageUrl: "",
  endpointPlaceholder: "",
  endpointDescription: "",
  regionPlaceholder: "",
  supportsSessionToken: false,
});
