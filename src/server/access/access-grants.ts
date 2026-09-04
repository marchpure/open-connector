import type { AccessPolicySnapshot, ActionPolicyDecision, PolicyCheck } from "../../core/action-policy.ts";
import type { ActionDefinition } from "../../core/types.ts";

export type AccessGrantRole = "reader" | "operator" | "custom";
export type AccessGrantSubjectType = "user" | "group";
export type AccessGrantEffect = "allow" | "deny";

export interface IdentityProviderConfig {
  issuer: string;
  audience: string;
  jwksUri: string;
  userPoolRef: string;
  subjectClaim: string;
  groupsClaim: string;
  tenantClaim?: string;
  tenant?: string;
  allowedClientIds?: string[];
  tokenTypeClaim?: string;
  tokenType?: string;
  requireGroupsClaim?: boolean;
  requireNbf?: boolean;
  requireUserPoolRefInIssuer?: boolean;
  requireAccessTokenClaims?: boolean;
  userinfoUri?: string;
}

export interface RuntimeSubject {
  issuer: string;
  audience: string;
  userPoolRef: string;
  tenant?: string;
  sub: string;
  groups: string[];
}

export interface AccessGrantRecord {
  id: string;
  subjectType: AccessGrantSubjectType;
  subject: string;
  connectionId: string;
  role: AccessGrantRole;
  effect: AccessGrantEffect;
  customActions: string[];
  reason?: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface AccessGrantInput {
  subjectType: AccessGrantSubjectType;
  subject: string;
  connectionId: string;
  role: AccessGrantRole;
  effect?: AccessGrantEffect;
  customActions?: string[];
  reason?: string;
}

export interface AccessPolicyVersion {
  version: number;
  updatedAt: string;
}

export interface AccessAuditRecord {
  id: string;
  requestId: string;
  subject: RuntimeSubject;
  connectionId?: string;
  actionId?: string;
  decision: ActionPolicyDecision;
  createdAt: string;
}

export interface AccessAuditListInput {
  limit?: number;
}

export interface IAccessGrantStore {
  getIdentityProviderConfig(): Promise<IdentityProviderConfig | undefined>;
  setIdentityProviderConfig(config: IdentityProviderConfig): Promise<void>;
  listGrants(): Promise<AccessGrantRecord[]>;
  addGrant(grant: AccessGrantRecord): Promise<void>;
  updateGrant(
    id: string,
    patch: Partial<Pick<AccessGrantRecord, "role" | "effect" | "customActions" | "reason" | "updatedAt">>,
  ): Promise<AccessGrantRecord | undefined>;
  revokeGrant(id: string, revokedAt: string): Promise<AccessGrantRecord | undefined>;
  getPolicyVersion(): Promise<AccessPolicyVersion>;
  bumpPolicyVersion(updatedAt: string): Promise<AccessPolicyVersion>;
  recordSubject(subject: RuntimeSubject, seenAt: string): Promise<void>;
  listSubjects(): Promise<RuntimeSubject[]>;
  addAudit(record: AccessAuditRecord): Promise<void>;
  listAudit(input?: AccessAuditListInput): Promise<AccessAuditRecord[]>;
}

export class AccessGrantService {
  private readonly store: IAccessGrantStore;

  constructor(store: IAccessGrantStore) {
    this.store = store;
  }

  getIdentityProviderConfig(): Promise<IdentityProviderConfig | undefined> {
    return this.store.getIdentityProviderConfig();
  }

  async upsertIdentityProviderConfig(config: IdentityProviderConfig): Promise<IdentityProviderConfig> {
    await this.store.setIdentityProviderConfig(normalizeIdentityProviderConfig(config));
    return (await this.store.getIdentityProviderConfig())!;
  }

  listGrants(): Promise<AccessGrantRecord[]> {
    return this.store.listGrants();
  }

  async createGrant(input: AccessGrantInput): Promise<AccessGrantRecord> {
    const now = new Date().toISOString();
    const grant: AccessGrantRecord = {
      ...normalizeGrantInput(input),
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.addGrant(grant);
    await this.store.bumpPolicyVersion(now);
    return grant;
  }

  async updateGrant(id: string, input: Partial<AccessGrantInput>): Promise<AccessGrantRecord | undefined> {
    const now = new Date().toISOString();
    const patch: Partial<Pick<AccessGrantRecord, "role" | "effect" | "customActions" | "reason" | "updatedAt">> = {
      updatedAt: now,
    };
    if (input.role !== undefined) patch.role = normalizeRole(input.role);
    if (input.effect !== undefined) patch.effect = normalizeEffect(input.effect);
    if (input.customActions !== undefined) patch.customActions = normalizeActions(input.customActions);
    if (input.reason !== undefined) patch.reason = normalizeOptionalString(input.reason);
    const updated = await this.store.updateGrant(id, patch);
    if (updated) await this.store.bumpPolicyVersion(now);
    return updated;
  }

  async revokeGrant(id: string): Promise<AccessGrantRecord | undefined> {
    const now = new Date().toISOString();
    const revoked = await this.store.revokeGrant(id, now);
    if (revoked) await this.store.bumpPolicyVersion(now);
    return revoked;
  }

  async createSnapshot(
    subject: RuntimeSubject,
    requestId: string = crypto.randomUUID(),
  ): Promise<AccessGrantPolicySnapshot> {
    const [version, grants] = await Promise.all([this.store.getPolicyVersion(), this.store.listGrants()]);
    await this.store.recordSubject(subject, new Date().toISOString());
    return new AccessGrantPolicySnapshot(
      version.version,
      subject,
      grants.filter((grant) => !grant.revokedAt),
      this,
      requestId,
    );
  }

  listSubjects(): Promise<RuntimeSubject[]> {
    return this.store.listSubjects();
  }

  listAudit(input?: AccessAuditListInput): Promise<AccessAuditRecord[]> {
    return this.store.listAudit(input);
  }

  async audit(input: Omit<AccessAuditRecord, "id" | "createdAt">): Promise<void> {
    await this.store.addAudit({
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
  }
}

export class AccessGrantPolicySnapshot implements AccessPolicySnapshot {
  readonly version: number;
  private readonly subject: RuntimeSubject;
  private readonly grants: AccessGrantRecord[];
  private readonly auditService: AccessGrantService;
  private readonly requestId: string;

  constructor(
    version: number,
    subject: RuntimeSubject,
    grants: AccessGrantRecord[],
    auditService: AccessGrantService,
    requestId: string,
  ) {
    this.version = version;
    this.subject = subject;
    this.grants = grants.filter((grant) => subjectMatchesGrant(subject, grant));
    this.auditService = auditService;
    this.requestId = requestId;
  }

  evaluateConnection(connectionId?: string): ActionPolicyDecision {
    const decision = this.decide(connectionId, undefined);
    void this.auditService.audit({ requestId: this.requestId, subject: this.subject, connectionId, decision });
    return decision;
  }

  evaluateAction(action: ActionDefinition, connectionId?: string): ActionPolicyDecision {
    const decision = this.decide(connectionId, action);
    void this.auditService.audit({
      requestId: this.requestId,
      subject: this.subject,
      connectionId,
      actionId: action.id,
      decision,
    });
    return decision;
  }

  private decide(connectionId: string | undefined, action: ActionDefinition | undefined): ActionPolicyDecision {
    if (!connectionId) {
      return denied("connection_not_allowed", "The selected connection is not granted to this subject.", [
        allowMiss(this.version, "No concrete connection id was selected."),
      ]);
    }

    const candidates = this.grants.filter((grant) => grant.connectionId === connectionId);
    const denyingGrant = candidates.find((grant) => grant.effect === "deny");
    if (denyingGrant) {
      return denied(
        action ? "action_blocked" : "connection_not_allowed",
        action
          ? `${action.id} is denied for this subject on connection ${connectionId}.`
          : `${connectionId} connection is denied for this subject.`,
        [grantCheck(denyingGrant, "block_match", this.version)],
      );
    }

    const allowingGrant = candidates.find(
      (grant) => grant.effect === "allow" && (!action || roleAllowsAction(grant, action)),
    );
    if (!allowingGrant) {
      return denied(
        action ? "action_not_allowed" : "connection_not_allowed",
        action
          ? `${action.id} is not granted to this subject on connection ${connectionId}.`
          : `${connectionId} connection is not granted to this subject.`,
        [allowMiss(this.version, "No matching AccessGrant allow rule.")],
      );
    }

    return { allowed: true, checks: [grantCheck(allowingGrant, "allow_match", this.version)] };
  }
}

export function roleAllowsAction(
  grant: Pick<AccessGrantRecord, "role" | "customActions">,
  action: ActionDefinition,
): boolean {
  if (grant.role === "custom") {
    return grant.customActions.includes(action.id);
  }
  if (grant.role === "reader") {
    return isReadAction(action);
  }
  return isReadAction(action) || isOperatorAction(action);
}

export function isReadAction(action: ActionDefinition): boolean {
  return /^(get|list|read|search|find|query|describe|retrieve|fetch|lookup|export|download|count|inspect|preview)_?/i.test(
    action.name,
  );
}

export function isOperatorAction(action: ActionDefinition): boolean {
  return /^(create|update|patch|set|add|remove|delete|send|post|put|upload|import|run|execute|start|stop|cancel|approve|reject)_?/i.test(
    action.name,
  );
}

function denied(
  code: Exclude<ActionPolicyDecision, { allowed: true }>["code"],
  message: string,
  checks: PolicyCheck[],
): ActionPolicyDecision {
  return { allowed: false, code, message, checks };
}

function subjectMatchesGrant(subject: RuntimeSubject, grant: AccessGrantRecord): boolean {
  return grant.subjectType === "user" ? subject.sub === grant.subject : subject.groups.includes(grant.subject);
}

function grantCheck(grant: AccessGrantRecord, outcome: "allow_match" | "block_match", version: number): PolicyCheck {
  return {
    source: "access_grant",
    outcome,
    rule: grant.connectionId,
    grantId: grant.id,
    role: grant.role,
    reason: grant.reason,
    policyVersion: version,
  } as PolicyCheck;
}

function allowMiss(version: number, reason: string): PolicyCheck {
  return { source: "access_grant", outcome: "allow_miss", reason, policyVersion: version } as PolicyCheck;
}

function normalizeIdentityProviderConfig(config: IdentityProviderConfig): IdentityProviderConfig {
  const normalized = {
    issuer: requiredNonEmpty(config.issuer, "issuer"),
    audience: requiredNonEmpty(config.audience, "audience"),
    jwksUri: requiredNonEmpty(config.jwksUri, "jwksUri"),
    userPoolRef: requiredNonEmpty(config.userPoolRef, "userPoolRef"),
    subjectClaim: requiredNonEmpty(config.subjectClaim, "subjectClaim"),
    groupsClaim: requiredNonEmpty(config.groupsClaim, "groupsClaim"),
    tenantClaim: normalizeOptionalString(config.tenantClaim),
    tenant: normalizeOptionalString(config.tenant),
    allowedClientIds: normalizeActions(config.allowedClientIds ?? []),
    tokenTypeClaim: normalizeOptionalString(config.tokenTypeClaim),
    tokenType: normalizeOptionalString(config.tokenType),
    requireGroupsClaim: config.requireGroupsClaim === true,
    requireNbf: config.requireNbf === true,
    requireUserPoolRefInIssuer: config.requireUserPoolRefInIssuer === true,
    requireAccessTokenClaims: config.requireAccessTokenClaims === true,
    userinfoUri: normalizeOptionalString(config.userinfoUri),
  };
  return normalized;
}

function normalizeGrantInput(input: AccessGrantInput): Omit<AccessGrantRecord, "id" | "createdAt" | "updatedAt"> {
  return {
    subjectType: normalizeSubjectType(input.subjectType),
    subject: requiredNonEmpty(input.subject, "subject"),
    connectionId: requiredNonEmpty(input.connectionId, "connectionId"),
    role: normalizeRole(input.role),
    effect: normalizeEffect(input.effect ?? "allow"),
    customActions: normalizeActions(input.customActions ?? []),
    reason: normalizeOptionalString(input.reason),
  };
}

function normalizeSubjectType(value: string): AccessGrantSubjectType {
  if (value === "user" || value === "group") return value;
  throw new Error("subjectType must be user or group.");
}

function normalizeRole(value: string): AccessGrantRole {
  if (value === "reader" || value === "operator" || value === "custom") return value;
  throw new Error("role must be reader, operator, or custom.");
}

function normalizeEffect(value: string): AccessGrantEffect {
  if (value === "allow" || value === "deny") return value;
  throw new Error("effect must be allow or deny.");
}

function normalizeActions(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requiredNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
