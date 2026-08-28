import type { ProviderDefinition } from "../../core/types.ts";

import { s3CompatibleDefinition } from "../s3-compatible-profile.ts";

export const provider: ProviderDefinition = s3CompatibleDefinition({
  service: "minio",
  displayName: "MinIO",
  description: "Read bounded objects from an allowlisted self-hosted S3-compatible MinIO bucket.",
  homepageUrl: "https://min.io",
  endpointPlaceholder: "https://minio.example.com",
  endpointDescription: "Trusted MinIO origin. Private networks require the deployment-level private-network opt-in.",
  regionPlaceholder: "us-east-1",
  forcePathStyle: true,
});
