import type { ActionDefinition } from "../../core/types.ts";

import { s3CompatibleActions } from "../s3-compatible-profile.ts";

export const actions: ActionDefinition[] = s3CompatibleActions({
  service: "minio",
  displayName: "MinIO",
  description: "",
  homepageUrl: "",
  endpointPlaceholder: "",
  endpointDescription: "",
  regionPlaceholder: "",
  forcePathStyle: true,
});
