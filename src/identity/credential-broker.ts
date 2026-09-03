import type { TenantPrincipal } from "../control-plane/types.ts";
import type { ResolvedCredential } from "../core/types.ts";

export type CredentialBrokerResult =
  | { status: "ready"; credential: ResolvedCredential }
  | { status: "authorization_required"; authorizationUrl: string };

export interface CredentialBroker {
  resolve(input: {
    credentialRef: string;
    principal: TenantPrincipal;
    resourceId: string;
    service: string;
    signal?: AbortSignal;
  }): Promise<CredentialBrokerResult>;
}

export class CredentialAuthorizationRequiredError extends Error {
  readonly code = "authorization_required";
  readonly authorizationUrl: string;

  constructor(authorizationUrl: string) {
    super("User authorization is required before this resource can be used.");
    this.authorizationUrl = authorizationUrl;
    this.name = "CredentialAuthorizationRequiredError";
  }
}

export class HttpCredentialBroker implements CredentialBroker {
  private readonly endpoint: URL;
  private readonly bearerToken: string;
  private readonly fetcher: typeof fetch;

  constructor(endpoint: URL, bearerToken: string, fetcher: typeof fetch = fetch) {
    this.endpoint = endpoint;
    this.bearerToken = bearerToken;
    this.fetcher = fetcher;
    if (endpoint.protocol !== "https:") throw new Error("Credential broker endpoint must use HTTPS.");
  }

  async resolve(input: Parameters<CredentialBroker["resolve"]>[0]): Promise<CredentialBrokerResult> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      signal: input.signal,
      headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        credentialRef: input.credentialRef,
        resourceId: input.resourceId,
        service: input.service,
        subject: input.principal.subject,
        userId: input.principal.ownerId,
        tenantId: input.principal.tenantId,
        agentId: input.principal.agentId,
        groups: input.principal.groups,
        groupIds: input.principal.groupIds,
      }),
    });
    if (!response.ok) throw new Error("Credential broker request failed.");
    const body = (await response.json()) as Record<string, unknown>;
    if (body.status === "authorization_required" && typeof body.authorizationUrl === "string") {
      const authorizationUrl = new URL(body.authorizationUrl);
      if (authorizationUrl.protocol !== "https:") {
        throw new Error("Credential broker authorization URL must use HTTPS.");
      }
      return { status: "authorization_required", authorizationUrl: authorizationUrl.toString() };
    }
    if (body.status !== "ready" || !body.credential || typeof body.credential !== "object") {
      throw new Error("Credential broker returned an invalid response.");
    }
    const credential = body.credential as ResolvedCredential;
    if (!credential.authType || credential.authType === "no_auth") {
      throw new Error("Credential broker returned an unsupported credential.");
    }
    return { status: "ready", credential };
  }
}
