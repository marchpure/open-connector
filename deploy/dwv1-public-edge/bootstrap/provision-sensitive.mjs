import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  KMSClient,
  SetSecretValueCommand,
} from "@volcengine/kms";
import {
  CLIConfigCredentialProvider,
  Client,
  Command,
  buildRequestConfigFromMetaPath,
} from "@volcengine/sdk-core";

class OpenApiCommand extends Command {
  constructor(metaPath, input) {
    super(input);
    this.requestConfig = buildRequestConfigFromMetaPath(metaPath);
  }
}

const configPath = process.argv[2];
if (!configPath)
  throw new Error("usage: node provision-sensitive.mjs CONFIG_JSON");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.profile !== "default" || config.region !== "cn-beijing") {
  throw new Error("Only default profile in cn-beijing is allowed.");
}
if (config.postgresql.reuseApproved !== true)
  throw new Error("PostgreSQL reuse is not approved.");

const credentialProvider = new CLIConfigCredentialProvider();
const rds = new Client({ region: "cn-beijing", credentialProvider });
const kms = new KMSClient({ region: "cn-beijing", credentialProvider });
const accountExists = config.postgresql.accountExists === true;
const databaseExists = config.postgresql.databaseExists === true;
const secretExists = config.kms.secretExists === true;
try {
  if (accountExists !== secretExists) {
    throw new Error(
      "Existing PostgreSQL account and KMS Secret must be adopted together.",
    );
  }

  const password = accountExists ? undefined : randomSecret(24);
  const accountResult = accountExists
    ? undefined
    : await rds.send(
        new OpenApiCommand(
          "/CreateDBAccount/2022-01-01/rds_postgresql/post/application_json/",
          {
            InstanceId: config.postgresql.instanceId,
            AccountName: config.postgresql.account,
            AccountPassword: password,
            AccountType: "Normal",
            AccountPrivileges: "Login,Inherit",
          },
        ),
      );
  const databaseResult = databaseExists
    ? undefined
    : await rds.send(
        new OpenApiCommand(
          "/CreateDatabase/2022-01-01/rds_postgresql/post/application_json/",
          {
            InstanceId: config.postgresql.instanceId,
            DBName: config.postgresql.database,
            Owner: config.postgresql.account,
            CharacterSetName: "utf8",
            Collate: "C.UTF-8",
            CType: "C.UTF-8",
          },
        ),
      );

  const secret = secretExists
    ? await readExistingSecret(kms, config.kms.secretName)
    : {
        OOMOL_CONNECT_DATABASE_URL:
          `postgresql://${encodeURIComponent(config.postgresql.account)}:${encodeURIComponent(password)}` +
          `@${config.postgresql.endpoint}:${config.postgresql.port}/${encodeURIComponent(config.postgresql.database)}`,
        OOMOL_CONNECT_ADMIN_TOKEN: randomSecret(32),
        OOMOL_CONNECT_RUNTIME_TOKEN: randomSecret(32),
        OOMOL_CONNECT_ENCRYPTION_KEY: randomSecret(32),
      };
  if (config.tos.enabled) {
    Object.assign(secret, {
      OOMOL_CONNECT_TRANSIT_FILE_BACKEND: "s3",
      OOMOL_CONNECT_TRANSIT_FILE_TTL_SECONDS: String(
        config.tos.lifecycleDays * 24 * 60 * 60,
      ),
      OOMOL_CONNECT_S3_BUCKET: config.tos.bucket,
      OOMOL_CONNECT_S3_REGION: config.tos.region,
      OOMOL_CONNECT_S3_ENDPOINT: config.tos.endpoint,
      OOMOL_CONNECT_S3_FORCE_PATH_STYLE: "false",
      TOS_CREDENTIAL_SOURCE: "VEFAAS_ROLE_STS",
    });
  }

  const secretResult = secretExists
    ? await kms.send(
        new SetSecretValueCommand({
          SecretName: config.kms.secretName,
          SecretValue: JSON.stringify(secret),
          VersionName: `v-${Date.now()}`,
        }),
      )
    : await kms.send(
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
      existingSensitiveValuesPreserved: secretExists,
      secretValuesRecorded: false,
    }),
  );
} catch (error) {
  const metadata = error?.data?.ResponseMetadata;
  console.error(
    JSON.stringify({
      error: metadata?.Error?.Code ?? "ProvisionFailed",
      action: metadata?.Action ?? null,
      requestId: metadata?.RequestId ?? null,
    }),
  );
  process.exitCode = 1;
}

async function readExistingSecret(kms, secretName) {
  const output = await kms.send(
    new GetSecretValueCommand({ SecretName: secretName }),
  );
  const value = output.SecretValue ?? output.Result?.SecretValue;
  if (typeof value !== "string") {
    throw new Error("Existing KMS Secret value is unavailable.");
  }
  const secret = JSON.parse(value);
  for (const key of [
    "OOMOL_CONNECT_DATABASE_URL",
    "OOMOL_CONNECT_ADMIN_TOKEN",
    "OOMOL_CONNECT_RUNTIME_TOKEN",
    "OOMOL_CONNECT_ENCRYPTION_KEY",
  ]) {
    if (typeof secret[key] !== "string" || !secret[key]) {
      throw new Error(`Existing KMS Secret is missing ${key}.`);
    }
  }
  return secret;
}

function randomSecret(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function requestId(output) {
  return output?.ResponseMetadata?.RequestId ?? null;
}
