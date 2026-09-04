import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CreateSecretCommand, KMSClient } from "@volcengine/kms";
import { Client, Command, buildRequestConfigFromMetaPath } from "@volcengine/sdk-core";

const configPath = process.argv[2];
if (!configPath) throw new Error("usage: node provision-sensitive.mjs CONFIG_JSON");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.profile !== "default" || config.region !== "cn-beijing") {
  throw new Error("Only default profile in cn-beijing is allowed.");
}
if (config.postgresql.reuseApproved !== true) throw new Error("PostgreSQL reuse is not approved.");

const password = randomSecret(24);
const adminToken = randomSecret(32);
const runtimeToken = randomSecret(32);
const encryptionKey = randomSecret(32);
const databaseUrl =
  `postgresql://${encodeURIComponent(config.postgresql.account)}:${encodeURIComponent(password)}` +
  `@${config.postgresql.endpoint}:${config.postgresql.port}/${encodeURIComponent(config.postgresql.database)}`;

const rds = new Client({ region: "cn-beijing" });
const accountResult = await rds.send(
  new OpenApiCommand("/CreateDBAccount/2022-01-01/rds_postgresql/post/application_json/", {
    InstanceId: config.postgresql.instanceId,
    AccountName: config.postgresql.account,
    AccountPassword: password,
    AccountType: "Normal",
    AccountPrivileges: "Login,Inherit",
  }),
);
const databaseResult = await rds.send(
  new OpenApiCommand("/CreateDatabase/2022-01-01/rds_postgresql/post/application_json/", {
    InstanceId: config.postgresql.instanceId,
    DBName: config.postgresql.database,
    Owner: config.postgresql.account,
    CharacterSetName: "utf8",
    Collate: "C.UTF-8",
    CType: "C.UTF-8",
  }),
);

const secret = {
  OOMOL_CONNECT_DATABASE_URL: databaseUrl,
  OOMOL_CONNECT_ADMIN_TOKEN: adminToken,
  OOMOL_CONNECT_RUNTIME_TOKEN: runtimeToken,
  OOMOL_CONNECT_ENCRYPTION_KEY: encryptionKey,
};
if (config.tos.enabled) {
  Object.assign(secret, {
    OOMOL_CONNECT_TRANSIT_FILE_BACKEND: "s3",
    OOMOL_CONNECT_S3_BUCKET: config.tos.bucket,
    OOMOL_CONNECT_S3_REGION: config.tos.region,
    OOMOL_CONNECT_S3_ENDPOINT: config.tos.endpoint,
    OOMOL_CONNECT_S3_FORCE_PATH_STYLE: "false",
    TOS_CREDENTIAL_SOURCE: "VEFAAS_ROLE_STS",
  });
}

const kms = new KMSClient({ region: "cn-beijing" });
const secretResult = await kms.send(
  new CreateSecretCommand({
    SecretName: config.kms.secretName,
    SecretType: "Generic",
    SecretValue: JSON.stringify(secret),
    VersionName: "v1",
    ProjectName: "default",
    Description: "DWV1 OpenConnector dev runtime configuration",
  }),
);

console.log(
  JSON.stringify({
    account: config.postgresql.account,
    database: config.postgresql.database,
    secretName: config.kms.secretName,
    requestIds: {
      account: requestId(accountResult),
      database: requestId(databaseResult),
      secret: requestId(secretResult),
    },
    secretValuesRecorded: false,
  }),
);

class OpenApiCommand extends Command {
  constructor(metaPath, input) {
    super(input);
    this.requestConfig = buildRequestConfigFromMetaPath(metaPath);
  }
}

function randomSecret(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function requestId(output) {
  return output?.ResponseMetadata?.RequestId ?? null;
}
