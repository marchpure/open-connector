import { constants } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ConnectionServiceStartupConfig {
  host: string;
  port: number;
  dataDir: string;
  authSecret: string;
  encryptionKey: string;
  publicOrigin: string;
  allowPrivateNetwork: boolean;
  databaseEgressAllowlist: string[];
}

const minimumSecretLength = 32;

/**
 * Validate cloud-facing configuration before opening the listening socket.
 * Error messages deliberately name configuration keys without echoing values.
 */
export async function loadConnectionServiceStartupConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectionServiceStartupConfig> {
  const host = env.CONNECTION_SERVICE_HOST?.trim() || "127.0.0.1";
  const port = positiveInteger(env.CONNECTION_SERVICE_PORT, 3400, "CONNECTION_SERVICE_PORT");
  const dataDir = env.CONNECTION_SERVICE_DATA_DIR?.trim() || join(process.cwd(), "data", "connection-service");
  const authSecret = strongSecret(env.CONNECTION_SERVICE_AUTH_SECRET, "CONNECTION_SERVICE_AUTH_SECRET");
  const encryptionKey = strongSecret(env.CONNECTION_SERVICE_ENCRYPTION_KEY, "CONNECTION_SERVICE_ENCRYPTION_KEY");
  if (authSecret === encryptionKey) {
    throw new Error("CONNECTION_SERVICE_AUTH_SECRET and CONNECTION_SERVICE_ENCRYPTION_KEY must differ.");
  }

  const publicOrigin = validatePublicOrigin(env.CONNECTION_SERVICE_PUBLIC_ORIGIN);
  const egressPolicy = env.CONNECTION_SERVICE_EGRESS_POLICY?.trim() || "public-only";
  if (egressPolicy !== "public-only" && egressPolicy !== "private-allowlist") {
    throw new Error("CONNECTION_SERVICE_EGRESS_POLICY must be public-only or private-allowlist.");
  }
  const allowPrivateNetwork = parseBoolean(env.OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK);
  const databaseEgressAllowlist = (env.CONNECTION_DATABASE_EGRESS_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (egressPolicy === "public-only" && allowPrivateNetwork) {
    throw new Error("OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK must be false for the public-only egress policy.");
  }
  if (egressPolicy === "private-allowlist" && (!allowPrivateNetwork || databaseEgressAllowlist.length === 0)) {
    throw new Error(
      "The private-allowlist egress policy requires OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK=true and CONNECTION_DATABASE_EGRESS_ALLOWLIST.",
    );
  }
  if (env.NODE_ENV === "production" && !isAbsolute(dataDir)) {
    throw new Error("CONNECTION_SERVICE_DATA_DIR must be absolute in production.");
  }

  await assertWritableDataStore(dataDir);
  return {
    host,
    port,
    dataDir,
    authSecret,
    encryptionKey,
    publicOrigin,
    allowPrivateNetwork,
    databaseEgressAllowlist,
  };
}

function strongSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret || secret.length < minimumSecretLength || new Set(secret).size < 12) {
    throw new Error(`${name} must contain at least 32 characters with sufficient variation.`);
  }
  return secret;
}

function validatePublicOrigin(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error("CONNECTION_SERVICE_PUBLIC_ORIGIN is required.");
  }
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("CONNECTION_SERVICE_PUBLIC_ORIGIN must be a valid HTTPS origin.");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("CONNECTION_SERVICE_PUBLIC_ORIGIN must be a stable HTTPS origin without a path.");
  }
  return origin.origin;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new Error("OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK must be true or false.");
}

async function assertWritableDataStore(dataDir: string): Promise<void> {
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await access(dataDir, constants.R_OK | constants.W_OK | constants.X_OK);
    const probePath = join(dataDir, `.startup-probe-${process.pid}.sqlite`);
    const probe = new DatabaseSync(probePath);
    try {
      probe.exec("pragma journal_mode=delete; create table if not exists startup_probe (id integer primary key)");
      probe.exec("begin immediate; insert into startup_probe default values; rollback");
    } finally {
      probe.close();
      await rm(probePath, { force: true });
    }
  } catch {
    throw new Error("CONNECTION_SERVICE_DATA_DIR must be a writable SQLite-capable persistent directory.");
  }
}
