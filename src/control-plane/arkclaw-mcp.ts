import type { CatalogStore, RuntimeActionDefinition } from "../catalog-store.ts";
import type { ResolvedCredential } from "../core/types.ts";
import type { ActionRunResult } from "../server/actions/action-runner.ts";
import type { AppResourceRecord } from "./app-resource-store.ts";
import type { McpAuthorizationPhase, McpAuthorizer } from "./mcp-authorizer.ts";
import type { ControlPlaneDependencies, TenantRuntime } from "./service.ts";
import type { TenantPrincipal } from "./types.ts";
import type { CallToolResult } from "@modelcontextprotocol/server";

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ActionPolicyService } from "../core/action-policy.ts";
import { mergeManagedCredential } from "../identity/managed-credential.ts";
import { analyzeOracleReadOnlyQuery } from "./oracle-adapter.ts";
import { redactSecrets } from "./redaction.ts";
import { createTenantRuntime } from "./service.ts";

const maxMcpOutputBytes = 1024 * 1024;

export interface ArkClawMcpRequest {
  resource: AppResourceRecord;
  principal: TenantPrincipal;
  actorPrincipal?: TenantPrincipal;
  signal: AbortSignal;
  authentication: "api_key_m2m" | "bearer_user";
  authorizer?: McpAuthorizer;
}

/** MCP surface bound to one application-center resource and one verified TIP. */
export function createArkClawMcpServer(deps: ControlPlaneDependencies, request: ArkClawMcpRequest): McpServer {
  const runtime = createTenantRuntime(deps, request.principal);
  const server = new McpServer(
    { name: `open-connector-${request.resource.resourceId}`, version: "1.0.0" },
    { instructions: "Use only actions granted by the application resource." },
  );

  server.registerTool(
    "list_allowed_actions",
    { title: "List Allowed Actions", description: "List actions bound to this application resource.", inputSchema: {} },
    async () => {
      await assertAuthorized(request, "discovery");
      return toolResult(listAllowedActions(deps.catalog, request.resource));
    },
  );
  server.registerTool(
    "get_action_guide",
    {
      title: "Get Action Guide",
      description: "Get the input and output contract for an action bound to this application resource.",
      inputSchema: { actionId: z.string().trim().min(1) },
    },
    async ({ actionId }) => {
      await assertAuthorized(request, "discovery", actionId);
      return toolResult(getActionGuide(deps.catalog, request.resource, actionId));
    },
  );
  server.registerTool(
    "execute_action",
    {
      title: "Execute Action",
      description: "Execute one action against the connection bound to this application resource.",
      inputSchema: {
        actionId: z.string().trim().min(1),
        input: z.record(z.string(), z.unknown()).default({}),
      },
    },
    async ({ actionId, input }, context) =>
      toolResult(
        await (async () => {
          await assertAuthorized(request, "execution", actionId);
          return executeAction(
            deps.catalog,
            runtime,
            request,
            actionId,
            input,
            AbortSignal.any([request.signal, context.mcpReq.signal]),
          );
        })(),
      ),
  );
  registerDirectActionTools(server, deps.catalog, runtime, request);
  return server;
}

function registerDirectActionTools(
  server: McpServer,
  catalog: CatalogStore,
  runtime: TenantRuntime,
  request: ArkClawMcpRequest,
): void {
  for (const actionId of request.resource.allowedActions) {
    const action = catalog.actionsById.get(actionId);
    if (!action || action.service !== "oracle_database" || !action.execution.locallyExecutable) continue;
    const inputSchema = z.fromJSONSchema(action.inputSchema);
    server.registerTool(
      action.name,
      {
        title: action.name
          .split("_")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" "),
        description: action.description,
        inputSchema,
      },
      async (input, context) =>
        toolResult(
          await (async () => {
            await assertAuthorized(request, "execution", action.id);
            return executeAction(
              catalog,
              runtime,
              request,
              action.id,
              input as Record<string, unknown>,
              AbortSignal.any([request.signal, context.mcpReq.signal]),
            );
          })(),
        ),
    );
  }
}

async function assertAuthorized(
  request: ArkClawMcpRequest,
  phase: McpAuthorizationPhase,
  actionId?: string,
): Promise<void> {
  const decision = await (request.authorizer ?? failClosedAuthorizer).authorize({
    phase,
    principal: request.principal,
    resource: request.resource,
    actionId,
    authentication: request.authentication,
    request: new Request("https://open-connector.invalid/mcp"),
  });
  if (!decision.allowed) throw new Error(decision.reason ?? "MCP request is not authorized.");
}

const failClosedAuthorizer: McpAuthorizer = {
  authorize: (request) =>
    request.authentication === "api_key_m2m"
      ? { allowed: true }
      : { allowed: false, reason: "MCP user authorization policy is not configured." },
};

function listAllowedActions(catalog: CatalogStore, resource: AppResourceRecord): Record<string, unknown> {
  return success({
    resourceId: resource.resourceId,
    actions: resource.allowedActions.flatMap((id) => {
      const action = catalog.actionsById.get(id);
      return action ? [{ id: action.id, name: action.name, description: action.description }] : [];
    }),
  });
}

function getActionGuide(catalog: CatalogStore, resource: AppResourceRecord, actionId: string): Record<string, unknown> {
  const action = getAllowedAction(catalog, resource, actionId);
  return success({
    id: action.id,
    name: action.name,
    description: action.description,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
    requiredScopes: action.requiredScopes,
    providerPermissions: action.providerPermissions,
  });
}

async function executeAction(
  catalog: CatalogStore,
  runtime: TenantRuntime,
  request: ArkClawMcpRequest,
  actionId: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let action: RuntimeActionDefinition;
  let getCredential: ((service: string) => Promise<ResolvedCredential | undefined>) | undefined;
  try {
    action = getAllowedAction(catalog, request.resource, actionId);
    assertOracleResourceScope(actionId, input, request.resource.allowedResources);
    if (request.resource.credentialRef) {
      const broker = runtimeCredentialBroker(runtime);
      const resolved = await broker.resolve({
        credentialRef: request.resource.credentialRef,
        principal: request.actorPrincipal ?? request.principal,
        resourceId: request.resource.resourceId,
        service: action.service,
        signal,
      });
      if (resolved.status === "authorization_required") {
        return {
          ok: false,
          error: {
            code: "authorization_required",
            message: "User authorization is required before this resource can be used.",
            authorizationUrl: resolved.authorizationUrl,
          },
        };
      }
      const base = await runtime.connectionService.getCredential(
        action.service,
        await connectionName(runtime, request.resource.connectionId),
      );
      getCredential = async (service: string) =>
        service === action.service ? mergeManagedCredential(base, resolved.credential, service) : undefined;
    }
  } catch (error) {
    return failure("action_not_allowed", error instanceof Error ? error.message : "Action is not allowed.");
  }
  const run = await runtime.actions.run({
    actionId: action.id,
    input,
    caller: "mcp",
    connectionName: await connectionName(runtime, request.resource.connectionId),
    policy: createResourcePolicy(request.resource),
    invocationId: `arkclaw:${request.resource.resourceId}`,
    signal,
    getCredential,
    actor: {
      tenantId: request.actorPrincipal?.tenantId ?? request.principal.tenantId,
      userId: request.actorPrincipal?.ownerId ?? request.principal.ownerId,
      subject: request.actorPrincipal?.subject ?? request.principal.subject,
      agentId: request.actorPrincipal?.agentId ?? request.principal.agentId,
      groups: request.actorPrincipal?.groups ?? request.principal.groups,
      groupIds: request.actorPrincipal?.groupIds ?? request.principal.groupIds,
    },
  });
  if (!run) return failure("unknown_action", "The action is not available.");
  return run.result.ok
    ? { ok: true, data: run.result.output, ...executionMeta(run) }
    : {
        ok: false,
        error: run.result.error ?? { code: "execution_failed", message: "Action execution failed." },
        ...executionMeta(run),
      };
}

function runtimeCredentialBroker(runtime: TenantRuntime) {
  if (!runtime.credentialBroker) throw new Error("Credential broker is not configured.");
  return runtime.credentialBroker;
}

function assertOracleResourceScope(
  actionId: string,
  input: Record<string, unknown>,
  scope: AppResourceRecord["allowedResources"],
): void {
  if (!scope) return;
  const schemas = new Set((scope.schemas ?? []).map(normalize));
  const tables = new Set((scope.tables ?? []).map(normalize));
  const schema = typeof input.schema === "string" ? normalize(input.schema) : undefined;
  const table = typeof input.table === "string" ? normalize(input.table) : undefined;
  if (schema && schemas.size && !schemas.has(schema))
    throw new Error("Oracle schema is outside the app resource scope.");
  if (table && tables.size && !tables.has(table) && !tables.has(`${schema ?? "*"}.${table}`)) {
    throw new Error("Oracle table is outside the app resource scope.");
  }
  if (actionId.endsWith("execute_read_query")) {
    const query = typeof input.query === "string" ? input.query : "";
    const lineage = analyzeOracleReadOnlyQuery(query);
    if (
      lineage.some(
        (item) =>
          (schemas.size > 0 && (!item.schema || !schemas.has(normalize(item.schema)))) ||
          (tables.size > 0 &&
            !tables.has(normalize(item.object)) &&
            !tables.has(`${item.schema ? normalize(item.schema) : "*"}.${normalize(item.object)}`)),
      )
    ) {
      throw new Error("Oracle query is outside the app resource scope.");
    }
  }
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

function getAllowedAction(
  catalog: CatalogStore,
  resource: AppResourceRecord,
  actionId: string,
): RuntimeActionDefinition {
  if (!resource.allowedActions.includes(actionId))
    throw new Error("Action is not granted to this application resource.");
  const action = catalog.actionsById.get(actionId);
  if (!action || action.service !== "oracle_database") {
    throw new Error("Action is not a supported action for this application resource.");
  }
  return action;
}

async function connectionName(runtime: TenantRuntime, connectionId: string): Promise<string> {
  const connection = runtime.connections.visibleRecord(connectionId);
  if (!connection) throw new Error("The application resource connection is not visible.");
  return connection.connectionName;
}

function createResourcePolicy(resource: AppResourceRecord) {
  return new ActionPolicyService().createSnapshot(undefined, {
    allowedActions: resource.allowedActions,
    blockedActions: [],
    allowedProxies: [],
    allowedConnections: [resource.connectionId],
  });
}

function success(data: unknown): Record<string, unknown> {
  return { ok: true, data };
}

function failure(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}

function executionMeta(run: ActionRunResult): Record<string, unknown> {
  return { executionId: run.executionId, auditPersisted: run.auditPersisted };
}

function toolResult(payload: Record<string, unknown>): CallToolResult {
  const safe = boundedMcpPayload(redactMcpPayload(payload));
  const text = JSON.stringify(safe);
  return {
    content: [{ type: "text", text }],
    structuredContent: safe,
    ...(safe.ok === false ? { isError: true } : {}),
  };
}

function redactMcpPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactSecrets(payload) as Record<string, unknown>;
  const error = payload.error;
  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    if (candidate.code === "authorization_required" && typeof candidate.authorizationUrl === "string") {
      const authorizationUrl = new URL(candidate.authorizationUrl);
      if (authorizationUrl.protocol === "https:") {
        redacted.error = {
          ...(redacted.error as Record<string, unknown>),
          authorizationUrl: authorizationUrl.toString(),
        };
      }
    }
  }
  return redacted;
}

function boundedMcpPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength <= maxMcpOutputBytes
    ? payload
    : failure("output_too_large", "MCP output exceeded the response limit.");
}
