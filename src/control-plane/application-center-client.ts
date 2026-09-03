import { createHash, createHmac, randomUUID } from "node:crypto";

export interface ApplicationCenterTop {
  accountId: number;
  userId?: number;
  roleId?: number;
  region: string;
  sourceService: string;
  destService: string;
  requestId?: string;
  realIp?: string;
  isInternal?: number;
  psm?: string;
  site?: string;
}

export interface ApplicationCenterConfig {
  endpoint: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  service?: string;
  top: ApplicationCenterTop;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export interface CredentialAuthConfig {
  Type: "api_key" | "oauth2";
  OAuthConfig?: Array<{
    Vendor: string;
    Name: string;
    Oauth2ProviderConfig: {
      ClientId: string;
      ClientSecret?: string;
      Flow?: "USER_FEDERATION" | "M2M" | string;
      Scopes?: string[];
      Oauth2Discovery?: { DiscoveryUrl: string };
      RedirectUrl?: string;
      MaxExpires?: number;
      ForceAuthentication?: boolean;
    };
  }>;
  ApikeyConfig?: Array<{
    Name: string;
    ApiKey: string;
    ApiKeyMetadata?: Array<{ Location: string; ParameterName: string; Prefix?: string }>;
  }>;
}

export interface ApplicationCenterAuthConfig {
  Type: "KEY_AUTH" | "OAUTH";
  OAuthConfig?: Array<{
    CredentialProviderName: string;
    Flow?: "USER_FEDERATION" | "M2M" | string;
  }>;
  ApikeyConfig?: Array<{
    CredentialProviderName: string;
  }>;
}

export interface ApplicationCenterResource {
  Id: string;
  Type?: string;
  Name?: string;
  Status?: string;
  Url?: string;
  NetworkConfig?: { GatewayUrl?: string; GatewayUrlType?: string };
  AuthConfig?: Record<string, unknown>;
  CredentialAuthConfig?: Record<string, unknown>;
  ErrorMessage?: string;
}

export interface CreateApplicationResourceInput {
  spaceId: string;
  name: string;
  description?: string;
  mcpUrl: string;
  /** Set only for a personal Claw/UserResource registration. */
  clawId?: string;
  userPoolUserUid?: string;
  userId?: string;
  userPoolUserId?: string;
  authConfig?: ApplicationCenterAuthConfig;
  credentialAuthConfig?: CredentialAuthConfig;
  visibility?: string;
  authorizedSubjects?: Array<{
    SubjectId: string;
    SubjectType: string;
    SubjectName?: string;
  }>;
}

export interface ApplicationCenterRegistry {
  createResource(input: CreateApplicationResourceInput, signal?: AbortSignal): Promise<ApplicationCenterResource>;
  getResource(
    resourceId: string,
    input: Pick<CreateApplicationResourceInput, "spaceId" | "clawId" | "userPoolUserUid" | "userId" | "userPoolUserId">,
    signal?: AbortSignal,
  ): Promise<ApplicationCenterResource>;
  listResources(
    spaceId: string,
    input: Pick<CreateApplicationResourceInput, "clawId" | "userPoolUserUid" | "userId" | "userPoolUserId">,
    signal?: AbortSignal,
  ): Promise<ApplicationCenterResource[]>;
  deleteResource(
    resourceId: string,
    input: Pick<CreateApplicationResourceInput, "spaceId" | "clawId" | "userPoolUserUid" | "userId" | "userPoolUserId">,
    signal?: AbortSignal,
  ): Promise<void>;
}

type Fetcher = typeof fetch;

/** Minimal ai_registry client matching mse-server's JSON + Volcengine V4 contract. */
export class VolcApplicationCenterRegistry implements ApplicationCenterRegistry {
  private readonly config: Required<Pick<ApplicationCenterConfig, "service" | "pollIntervalMs" | "pollTimeoutMs">> &
    ApplicationCenterConfig;
  private readonly fetcher: Fetcher;

  constructor(config: ApplicationCenterConfig, fetcher: Fetcher = fetch) {
    if (config.endpoint.protocol !== "https:") throw new Error("Application Center endpoint must use HTTPS.");
    if (!config.accessKeyId || !config.secretAccessKey || !config.region || config.top.accountId <= 0) {
      throw new Error("Application Center requires region, AK/SK, and a positive top accountId.");
    }
    this.config = {
      service: config.service ?? "ai_registry",
      pollIntervalMs: config.pollIntervalMs ?? 500,
      pollTimeoutMs: config.pollTimeoutMs ?? 15_000,
      ...config,
    };
    this.fetcher = fetcher;
  }

  async createResource(
    input: CreateApplicationResourceInput,
    signal?: AbortSignal,
  ): Promise<ApplicationCenterResource> {
    if (input.authConfig && input.credentialAuthConfig) {
      throw new Error("Application Center AuthConfig and CredentialAuthConfig are mutually exclusive.");
    }
    const result = await this.post(
      "CreateResource",
      {
        Type: "Mcp",
        SpaceId: input.spaceId,
        Name: input.name,
        ...(input.description ? { Description: input.description } : {}),
        McpConfig: { Source: "Standard", McpUrl: input.mcpUrl, Protocol: "http" },
        ...(input.clawId ? { clawId: input.clawId } : {}),
        ...(input.userPoolUserUid ? { UserPoolUserUid: input.userPoolUserUid } : {}),
        ...(input.userId ? { UserId: input.userId } : {}),
        ...(input.userPoolUserId ? { UserPoolUserId: input.userPoolUserId } : {}),
        ...(input.authConfig ? { AuthConfig: input.authConfig } : {}),
        ...(input.credentialAuthConfig ? { CredentialAuthConfig: input.credentialAuthConfig } : {}),
        ...(input.visibility ? { Visibility: input.visibility } : {}),
        ...(input.authorizedSubjects ? { AuthorizedSubjects: input.authorizedSubjects } : {}),
      },
      signal,
    );
    const id = typeof result.Id === "string" ? result.Id.trim() : "";
    if (!id) throw new Error("Application Center CreateResource returned no resource Id.");
    return this.waitForResource(id, input, signal);
  }

  async getResource(
    resourceId: string,
    input: Pick<CreateApplicationResourceInput, "spaceId" | "clawId" | "userPoolUserUid" | "userId" | "userPoolUserId">,
    signal?: AbortSignal,
  ): Promise<ApplicationCenterResource> {
    const result = await this.post(
      "GetResource",
      {
        Id: resourceId,
        SpaceId: input.spaceId,
        ClawId: input.clawId,
        ...(input.userPoolUserUid ? { UserPoolUserUid: input.userPoolUserUid } : {}),
        ...(input.userId ? { UserId: input.userId } : {}),
        ...(input.userPoolUserId ? { UserPoolUserId: input.userPoolUserId } : {}),
      },
      signal,
    );
    const resource = result.Resource;
    if (!resource || typeof resource !== "object") {
      throw new Error("Application Center GetResource returned no Resource.");
    }
    return resource as ApplicationCenterResource;
  }

  async listResources(
    spaceId: string,
    input: Pick<CreateApplicationResourceInput, "clawId" | "userPoolUserUid" | "userId" | "userPoolUserId">,
    signal?: AbortSignal,
  ): Promise<ApplicationCenterResource[]> {
    const result = await this.post(
      "ListResources",
      {
        PageNumber: 1,
        PageSize: 100,
        SpaceId: spaceId,
        ClawId: input.clawId,
        ...(input.userPoolUserUid ? { UserPoolUserUid: input.userPoolUserUid } : {}),
        ...(input.userId ? { UserId: input.userId } : {}),
        ...(input.userPoolUserId ? { UserPoolUserId: input.userPoolUserId } : {}),
      },
      signal,
    );
    return Array.isArray(result.Resources) ? (result.Resources as ApplicationCenterResource[]) : [];
  }

  async deleteResource(
    resourceId: string,
    input: Pick<CreateApplicationResourceInput, "spaceId" | "clawId" | "userPoolUserUid" | "userId" | "userPoolUserId">,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.post(
      "DeleteResource",
      {
        Id: resourceId,
        SpaceId: input.spaceId,
        ClawId: input.clawId,
        ...(input.userPoolUserUid ? { UserPoolUserUid: input.userPoolUserUid } : {}),
        ...(input.userId ? { UserId: input.userId } : {}),
        ...(input.userPoolUserId ? { UserPoolUserId: input.userPoolUserId } : {}),
      },
      signal,
    );
  }

  private async waitForResource(
    resourceId: string,
    input: CreateApplicationResourceInput,
    signal?: AbortSignal,
  ): Promise<ApplicationCenterResource> {
    const deadline = Date.now() + this.config.pollTimeoutMs;
    let latest: ApplicationCenterResource | undefined;
    while (Date.now() <= deadline) {
      latest = await this.getResource(resourceId, input, signal);
      const status = latest.Status?.trim().toUpperCase();
      if (status === "FAILED") {
        throw new Error(latest.ErrorMessage || "Application Center resource creation failed.");
      }
      if (["RUNNING", "READY"].includes(status ?? "")) {
        return latest;
      }
      await delay(this.config.pollIntervalMs, signal);
    }
    throw new Error("Application Center resource did not become ready before the polling timeout.");
  }

  private async post(
    action: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const payload = JSON.stringify(body);
    const url = new URL(this.config.endpoint);
    url.searchParams.set("Action", action);
    url.searchParams.set("Version", "2026-03-01");
    const headers = signedHeaders({
      method: "POST",
      url,
      body: payload,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      region: this.config.region,
      service: this.config.service,
      top: this.config.top,
    });
    const response = await this.fetcher(url, { method: "POST", signal, headers, body: payload });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Application Center ${action} returned invalid JSON.`);
    }
    if (!response.ok) throw new Error(`Application Center ${action} failed with HTTP ${response.status}.`);
    if (!parsed || typeof parsed !== "object")
      throw new Error(`Application Center ${action} returned an invalid response.`);
    const envelope = parsed as Record<string, unknown>;
    const metadata = envelope.ResponseMetadata as Record<string, unknown> | undefined;
    if (metadata?.Error) throw new Error(`Application Center ${action} returned an upstream error.`);
    const result = envelope.Result;
    return result && typeof result === "object" ? (result as Record<string, unknown>) : envelope;
  }
}

export function signedHeaders(
  input: {
    method: string;
    url: URL;
    body: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    service: string;
    top: ApplicationCenterTop;
  },
  now: Date = new Date(),
): Record<string, string> {
  const date = now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  const dateStamp = date.slice(0, 8);
  const bodyHash = sha256(input.body);
  const headers: Record<string, string> = {
    host: input.url.host,
    "content-type": "application/json",
    "x-content-sha256": bodyHash,
    "x-date": date,
    "x-top-account-id": String(input.top.accountId),
    "x-top-region": input.top.region,
    "x-top-service": input.top.destService,
    "x-top-source": input.top.sourceService,
    "x-top-request-id": input.top.requestId ?? randomUUID(),
  };
  if (input.top.userId !== undefined) headers["x-top-user-id"] = String(input.top.userId);
  if (input.top.roleId !== undefined) headers["x-top-role-id"] = String(input.top.roleId);
  if (input.top.realIp) headers["x-top-real-ip"] = input.top.realIp;
  if (input.top.isInternal !== undefined) headers["x-top-account-isinternal"] = String(input.top.isInternal);
  if (input.top.psm) headers["x-psm"] = input.top.psm;
  if (input.top.site) headers["x-top-site"] = input.top.site;
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((name) => `${name}:${canonicalHeaderValue(name, headers[name])}\n`).join("");
  const canonicalQuery = [...input.url.searchParams.entries()]
    .sort(([a], [b]) => lexicalCompare(a, b))
    .map(([key, value]) => `${encodeRFC3986(key)}=${encodeRFC3986(value)}`)
    .join("&");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.url.pathname || "/",
    canonicalQuery,
    canonicalHeaders,
    signed.join(";"),
    bodyHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${input.service}/request`;
  const stringToSign = ["HMAC-SHA256", date, scope, sha256(canonicalRequest)].join("\n");
  // Match volc-sdk-golang/base.Sign: the first derivation uses the raw secret.
  const signingKey = hmac(hmac(hmac(hmac(input.secretAccessKey, dateStamp), input.region), input.service), "request");
  const signature = hmac(signingKey, stringToSign);
  return {
    ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [canonicalHeaderName(key), value])),
    Authorization: `HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`,
  };
}

function canonicalHeaderName(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("-");
}
function canonicalHeaderValue(name: string, value: string): string {
  const trimmed = value.trim();
  if (name !== "host") return trimmed;
  try {
    const parsed = new URL(`https://${trimmed}`);
    if (parsed.port === "443" || parsed.port === "80") return parsed.hostname;
  } catch {
    // Preserve the original value and let the upstream signer reject malformed hosts.
  }
  return trimmed;
}
function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function encodeRFC3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function hmac(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Operation cancelled."));
      },
      { once: true },
    );
  });
}
