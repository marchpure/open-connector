import type { AppResourceRecord } from "./app-resource-store.ts";
import type { TenantPrincipal } from "./types.ts";

export type McpAuthorizationPhase = "discovery" | "execution";

export interface McpAuthorizationRequest {
  phase: McpAuthorizationPhase;
  principal: TenantPrincipal;
  resource: AppResourceRecord;
  actionId?: string;
  authentication: "api_key_m2m" | "bearer_user";
  request: Request;
}

export interface McpAuthorizationDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * W2 owns user policy. W1 keeps this boundary fail-closed for user Bearer
 * traffic while preserving the explicit legacy API-key M2M mode.
 */
export interface McpAuthorizer {
  authorize(request: McpAuthorizationRequest): McpAuthorizationDecision | Promise<McpAuthorizationDecision>;
}

export const failClosedMcpAuthorizer: McpAuthorizer = {
  authorize(request) {
    if (request.authentication === "api_key_m2m") return { allowed: true };
    return {
      allowed: false,
      reason: "MCP user authorization policy is not configured.",
    };
  },
};

export async function authorizeMcp(
  authorizer: McpAuthorizer | undefined,
  request: McpAuthorizationRequest,
): Promise<McpAuthorizationDecision> {
  return (authorizer ?? failClosedMcpAuthorizer).authorize(request);
}
