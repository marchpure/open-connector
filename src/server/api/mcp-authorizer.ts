import type { RuntimeSubject } from "../access/access-grants.ts";
import type { RuntimeAuthContext } from "./auth.ts";

export interface McpAuthorizationSubject {
  auth?: RuntimeAuthContext;
  identity?: RuntimeSubject;
}

export interface McpAuthorizationRequest {
  subject: McpAuthorizationSubject;
  toolName: string;
  actionId?: string;
}

export interface McpAuthorizationDecision {
  allowed: boolean;
  code?: string;
  message?: string;
}

export interface McpAuthorizer {
  readonly mode?: "m2m_only_fail_closed";
  authorizeToolDiscovery(subject: McpAuthorizationSubject): Promise<McpAuthorizationDecision>;
  authorizeToolExecution(request: McpAuthorizationRequest): Promise<McpAuthorizationDecision>;
}

export const mcpM2mAuthorizer: McpAuthorizer = {
  mode: "m2m_only_fail_closed",
  async authorizeToolDiscovery(subject) {
    return isM2mSubject(subject) || subject.identity ? allowedDecision() : failClosedUserDecision();
  },
  async authorizeToolExecution(request) {
    return isM2mSubject(request.subject) || request.subject.identity ? allowedDecision() : failClosedUserDecision();
  },
};

function isM2mSubject(subject: McpAuthorizationSubject): boolean {
  return (
    subject.auth?.kind === "bootstrap_token" || subject.auth?.kind === "stored_token" || subject.auth === undefined
  );
}

function allowedDecision(): McpAuthorizationDecision {
  return { allowed: true };
}

function failClosedUserDecision(): McpAuthorizationDecision {
  return {
    allowed: false,
    code: "authorization_failed",
    message: "MCP user authorization is not configured for this runtime.",
  };
}
