import { KMSClient, GetSecretValueCommand } from "@volcengine/kms";
import { spawn } from "node:child_process";
import http from "node:http";

const listenPort = readPort("PORT", 8080);
const internalPort = readPort("DWV1_INTERNAL_PORT", 3000);
const credentialPort = readPort("DWV1_CREDENTIAL_PORT", 18081);
const secretName = requiredEnv("DWV1_KMS_SECRET_NAME");
const role = requiredEnv("DWV1_OPENCONNECTOR_ROLE");
const allowedRoles = new Set(["control-plane", "mcp-runtime"]);
if (!allowedRoles.has(role)) throw new Error("Invalid DWV1_OPENCONNECTOR_ROLE.");

const allowedSecretKeys = new Set([
  "OOMOL_CONNECT_DATABASE_URL",
  "OOMOL_CONNECT_ADMIN_TOKEN",
  "OOMOL_CONNECT_RUNTIME_TOKEN",
  "OOMOL_CONNECT_ENCRYPTION_KEY",
  "OOMOL_CONNECT_TRANSIT_FILE_BACKEND",
  "OOMOL_CONNECT_TRANSIT_FILE_TTL_SECONDS",
  "OOMOL_CONNECT_S3_BUCKET",
  "OOMOL_CONNECT_S3_REGION",
  "OOMOL_CONNECT_S3_ENDPOINT",
  "OOMOL_CONNECT_S3_FORCE_PATH_STYLE",
  "OOMOL_CONNECT_S3_ACCESS_KEY_ID",
  "OOMOL_CONNECT_S3_SECRET_ACCESS_KEY",
  "OOMOL_CONNECT_S3_SESSION_TOKEN",
  "OOMOL_CONNECT_JWKS_URI",
  "OOMOL_CONNECT_JWT_ISSUER",
  "OOMOL_CONNECT_JWT_AUDIENCE",
  "OOMOL_CONNECT_JWT_USER_POOL_REF",
  "TOS_CREDENTIAL_SOURCE",
]);
const requiredSecretKeys = [
  "OOMOL_CONNECT_DATABASE_URL",
  "OOMOL_CONNECT_ADMIN_TOKEN",
  "OOMOL_CONNECT_RUNTIME_TOKEN",
  "OOMOL_CONNECT_ENCRYPTION_KEY",
];
const strippedHeaders = new Set([
  "x-faas-access-key-id",
  "x-faas-secret-access-key",
  "x-faas-session-token",
]);

let ready;
let currentCredentials;

http
  .createServer((request, response) => {
    if (request.url !== "/credentials" || !currentCredentials) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(
      JSON.stringify({
        AccessKeyId: currentCredentials.accessKeyId,
        SecretAccessKey: currentCredentials.secretAccessKey,
        Token: currentCredentials.sessionToken,
        Expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    );
  })
  .listen(credentialPort, "127.0.0.1");

const server = http.createServer(async (request, response) => {
  try {
    updateCredentials(request.headers);
    ready ??= bootstrap(request.headers);
    await ready;
    proxy(request, response);
  } catch (error) {
    ready = undefined;
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: "service_initialization_failed" }));
    console.error("OpenConnector bootstrap failed:", error instanceof Error ? error.message : "unknown error");
  }
});

server.listen(listenPort, "0.0.0.0");

async function bootstrap(headers) {
  const accessKeyId = singleHeader(headers["x-faas-access-key-id"]);
  const secretAccessKey = singleHeader(headers["x-faas-secret-access-key"]);
  const sessionToken = singleHeader(headers["x-faas-session-token"]);
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error("VeFaaS role credentials are missing.");
  }
  currentCredentials = { accessKeyId, secretAccessKey, sessionToken };

  const client = new KMSClient({
    region: "cn-beijing",
    accessKeyId,
    secretAccessKey,
    sessionToken,
  });
  const output = await client.send(new GetSecretValueCommand({ SecretName: secretName }));
  const value = output.SecretValue ?? output.Result?.SecretValue;
  if (typeof value !== "string") throw new Error("KMS Secret value is missing.");
  const secrets = JSON.parse(value);
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new Error("KMS Secret must be a JSON object.");
  }
  for (const key of Object.keys(secrets)) {
    if (!allowedSecretKeys.has(key)) throw new Error(`Unexpected KMS Secret key: ${key}`);
    if (typeof secrets[key] !== "string" || !secrets[key]) throw new Error(`Invalid KMS Secret key: ${key}`);
  }
  for (const key of requiredSecretKeys) {
    if (!secrets[key]) throw new Error(`Missing KMS Secret key: ${key}`);
  }

  const child = spawn("/usr/local/bin/open-connector", [role], {
    env: {
      ...process.env,
      ...secrets,
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_CONTAINER_CREDENTIALS_FULL_URI: `http://127.0.0.1:${credentialPort}/credentials`,
      HOST: "127.0.0.1",
      PORT: String(internalPort),
    },
    stdio: "inherit",
  });
  child.once("exit", (code, signal) => {
    console.error(`OpenConnector exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
    process.exit(code ?? 1);
  });
  await waitUntilReady();
}

function proxy(request, response) {
  const headers = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!strippedHeaders.has(key.toLowerCase()) && value !== undefined) headers[key] = value;
  }
  headers.host = `127.0.0.1:${internalPort}`;

  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: internalPort,
      path: request.url,
      method: request.method,
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers, "cache-control": "no-store" };
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "cache-control": "no-store" });
    response.end();
  });
  request.pipe(upstream);
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${internalPort}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("OpenConnector did not become ready.");
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function readPort(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${name}.`);
  return value;
}

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function updateCredentials(headers) {
  const accessKeyId = singleHeader(headers["x-faas-access-key-id"]);
  const secretAccessKey = singleHeader(headers["x-faas-secret-access-key"]);
  const sessionToken = singleHeader(headers["x-faas-session-token"]);
  if (accessKeyId && secretAccessKey && sessionToken) {
    currentCredentials = { accessKeyId, secretAccessKey, sessionToken };
  }
}
