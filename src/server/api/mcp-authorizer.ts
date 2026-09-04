import type { RuntimeSubject } from "../access/access-grants.ts";
import type { AccessGrantService } from "../access/access-grants.ts";
import type { RuntimeAuthContext } from "./auth.ts";

export interface McpAuthorizationSubject {
  auth?: RuntimeAuthContext;
  identity?: RuntimeSubject;
  discoveryAllowed?: boolean;
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

export function createMcpAuthorizer(accessGrants?: AccessGrantService): McpAuthorizer {
  return {
    mode: "m2m_only_fail_closed",
    async authorizeToolDiscovery(subject) {
      return authorizeSubject(subject, accessGrants);
    },
    async authorizeToolExecution(request) {
      return authorizeExecutionSubject(request.subject);
    },
  };
}

function authorizeExecutionSubject(subject: McpAuthorizationSubject): McpAuthorizationDecision {
  return isM2mSubject(subject) || subject.identity ? allowedDecision() : failClosedUserDecision();
}

async function authorizeSubject(
  subject: McpAuthorizationSubject,
  accessGrants?: AccessGrantService,
): Promise<McpAuthorizationDecision> {
  if (isM2mSubject(subject)) {
    return allowedDecision();
  }
  if (!subject.identity || !accessGrants) {
    return failClosedUserDecision();
  }
  const grants = await accessGrants.listGrants();
  const hasActiveGrant = grants.some(
    (grant) =>
      !grant.revokedAt &&
      ((grant.subjectType === "user" && grant.subject === subject.identity!.sub) ||
        (grant.subjectType === "group" && subject.identity!.groups.includes(grant.subject))),
  );
  return hasActiveGrant ? allowedDecision() : failClosedUserDecision();
}

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
