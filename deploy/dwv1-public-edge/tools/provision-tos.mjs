import { CLIConfigCredentialProvider } from "@volcengine/sdk-core";
import { StorageClassType, TosClient } from "@volcengine/tos-sdk";

const bucket = process.argv[2];
if (!bucket) throw new Error("usage: node provision-tos.mjs BUCKET_NAME");

const credentials =
  await new CLIConfigCredentialProvider().resolveCredentials();
const client = new TosClient({
  accessKeyId: credentials.accessKeyId,
  accessKeySecret: credentials.secretAccessKey,
  stsToken: credentials.sessionToken,
  region: "cn-beijing",
  endpoint: "tos-cn-beijing.volces.com",
});
await client.createBucket({
  bucket,
  acl: "private",
  storageClass: StorageClassType.StorageClassStandard,
});
await client.putBucketLifecycle({
  bucket,
  rules: [
    {
      id: "dwv1-transit-expiry",
      prefix: "transit/",
      status: "Enabled",
      expiration: { days: 2 },
      abortInCompleteMultipartUpload: { daysAfterInitiation: 1 },
    },
  ],
});
console.log(JSON.stringify({ bucket, private: true, lifecycleDays: 2 }));
