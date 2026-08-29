import type { CatalogStore, RuntimeActionDefinition } from "../catalog-store.ts";
import type { ActionRunResult } from "../server/actions/action-runner.ts";
import type { RunLog } from "../server/storage/runtime-store.ts";
import type { ControlPlaneDependencies, TenantRuntime } from "./service.ts";
import type { ConnectionLeaseClaims, ConnectionRecord, TenantPrincipal } from "./types.ts";
import type { CallToolResult } from "@modelcontextprotocol/server";

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { summarizeForRunLog } from "../server/actions/run-log-summary.ts";
import { ConnectionLeaseService, LeaseError } from "./lease.ts";
import { redactSecrets } from "./redaction.ts";
import { createLeasePolicy, createTenantRuntime } from "./service.ts";

const maxOutputBytes = 64 * 1024;
const executionTimeoutMs = 30_000;
const leaseCheckIntervalMs = 100;

export interface LeaseRuntimeMcpContext {
  token: string;
  invocationId: string;
  audience: string;
  claims: ConnectionLeaseClaims;
  principal: TenantPrincipal;
}

export function resolveLeaseRuntimeMcpContext(
  leases: ConnectionLeaseService,
  token: string | undefined,
  invocationId: string | undefined,
  audience: string | undefined,
): LeaseRuntimeMcpContext {
  if (!token || !invocationId || !audience) {
    throw new LeaseError("invalid_lease", "Lease, invocationId, and audience headers are required.");
  }
  const claims = leases.resolve(token, { invocationId, audience });
  return {
    token,
    invocationId,
    audience,
    claims,
    principal: {
      tenantId: claims.tenantId,
      workspaceId: claims.workspaceId,
      subject: claims.subject,
      ownerId: claims.ownerId,
      audience: claims.audience,
    },
  };
}

export function createLeaseRuntimeMcpServer(
  deps: ControlPlaneDependencies,
  request: LeaseRuntimeMcpContext,
  signal: AbortSignal,
): McpServer {
  const runtime = createTenantRuntime(deps, request.principal);
  const server = new McpServer(
    { name: "connection-service-runtime", version: "1.0.0" },
    { instructions: "Use only actions explicitly granted by the current connection lease." },
  );

  server.registerTool(
    "list_allowed_actions",
    {
      title: "List Allowed Actions",
      description: "List actions granted by the current connection lease.",
      inputSchema: {},
    },
    async () => toolResult(await listAllowedActions(deps.catalog, runtime, request)),
  );
  server.registerTool(
    "get_action_guide",
    {
      title: "Get Action Guide",
      description: "Get the bounded schema and usage details for one lease-allowed action.",
      inputSchema: { actionId: z.string().trim().min(1) },
    },
    async ({ actionId }) => toolResult(await getActionGuide(deps.catalog, runtime, request, actionId)),
  );
  server.registerTool(
    "execute_action",
    {
      title: "Execute Action",
      description: "Execute one action against the connection bound to the current lease.",
      inputSchema: {
        actionId: z.string().trim().min(1),
        input: z.record(z.string(), z.unknown()).default({}),
      },
    },
    async ({ actionId, input }) =>
      toolResult(await executeAction(deps.catalog, runtime, request, actionId, input, signal)),
  );
  return server;
}

export function assertLeaseRuntimeRequest(
  deps: ControlPlaneDependencies,
  request: LeaseRuntimeMcpContext,
): ConnectionRecord {
  const runtime = createTenantRuntime(deps, request.principal);
  const connection = verifyCurrentLease(runtime, request);
  for (const actionId of request.claims.allowedActions) {
    const action = deps.catalog.actionsById.get(actionId);
    if (!action || action.service !== connection.service || !action.execution.locallyExecutable) {
      throw new LeaseError("lease_scope_denied", "Lease contains an action outside the runtime connection.");
    }
    runtime.leases.verify(request.token, request.principal, {
      connectionId: connection.id,
      connectionRevision: connection.revision,
      actionId,
      invocationId: request.invocationId,
      audience: request.audience,
    });
  }
  return connection;
}

async function listAllowedActions(
  catalog: CatalogStore,
  runtime: TenantRuntime,
  request: LeaseRuntimeMcpContext,
): Promise<Record<string, unknown>> {
  try {
    const connection = verifyCurrentLease(runtime, request);
    return success({
      connectionId: connection.id,
      actions: request.claims.allowedActions.flatMap((actionId) => {
        const action = catalog.actionsById.get(actionId);
        return action && action.service === connection.service
          ? [{ id: action.id, name: action.name, description: action.description }]
          : [];
      }),
    });
  } catch (error) {
    return leaseFailure(error);
  }
}

async function getActionGuide(
  catalog: CatalogStore,
  runtime: TenantRuntime,
  request: LeaseRuntimeMcpContext,
  actionId: string,
): Promise<Record<string, unknown>> {
  try {
    const { action } = verifyAction(catalog, runtime, request, actionId);
    return success({
      id: action.id,
      name: action.name,
      description: action.description,
      inputSchema: action.inputSchema,
      outputSchema: action.outputSchema,
      requiredScopes: action.requiredScopes,
      providerPermissions: action.providerPermissions,
    });
  } catch (error) {
    return leaseFailure(error);
  }
}

async function executeAction(
  catalog: CatalogStore,
  runtime: TenantRuntime,
  request: LeaseRuntimeMcpContext,
  actionId: string,
  input: Record<string, unknown>,
  requestSignal: AbortSignal,
): Promise<Record<string, unknown>> {
  let selected: ConnectionRecord;
  try {
    selected = verifyAction(catalog, runtime, request, actionId).connection;
    await runtime.connectionService.resolveForExecution(selected.service, selected.connectionName);
    selected = verifyAction(catalog, runtime, request, actionId).connection;
  } catch (error) {
    await recordRejectedExecution(runtime, request, actionId, error);
    return leaseFailure(error);
  }

  const timeout = AbortSignal.timeout(executionTimeoutMs);
  const leaseAbort = new AbortController();
  const signal = AbortSignal.any([requestSignal, timeout, leaseAbort.signal]);
  const leaseWatch = setInterval(() => {
    try {
      verifyAction(catalog, runtime, request, actionId);
    } catch {
      leaseAbort.abort();
    }
  }, leaseCheckIntervalMs);
  let run;
  try {
    run = await runtime.actions.run({
      actionId,
      invocationId: request.invocationId,
      input,
      caller: "mcp",
      connectionName: selected.connectionName,
      policy: createLeasePolicy(request.claims),
      signal,
    });
  } finally {
    clearInterval(leaseWatch);
  }
  if (!run) {
    await recordRejectedExecution(runtime, request, actionId, new Error("Unknown action."));
    return failure("unknown_action", "The action is not available.");
  }

  try {
    verifyAction(catalog, runtime, request, actionId);
  } catch (error) {
    return {
      ...executionMeta(run),
      ...leaseFailure(error),
    };
  }
  return run.result.ok
    ? { ok: true, data: run.result.output, ...executionMeta(run) }
    : {
        ok: false,
        error: run.result.error ?? { code: "execution_failed", message: "Action execution failed." },
        ...executionMeta(run),
      };
}

function verifyAction(
  catalog: CatalogStore,
  runtime: TenantRuntime,
  request: LeaseRuntimeMcpContext,
  actionId: string,
): { connection: ConnectionRecord; action: RuntimeActionDefinition } {
  const connection = verifyCurrentLease(runtime, request);
  const action = catalog.actionsById.get(actionId);
  if (!action || action.service !== connection.service) {
    throw new LeaseError("lease_scope_denied", "Action does not belong to the leased connection.");
  }
  runtime.leases.verify(request.token, request.principal, {
    connectionId: connection.id,
    connectionRevision: connection.revision,
    actionId,
    invocationId: request.invocationId,
    audience: request.audience,
  });
  return { connection, action };
}

function verifyCurrentLease(runtime: TenantRuntime, request: LeaseRuntimeMcpContext): ConnectionRecord {
  if (request.claims.connectionIds.length !== 1) {
    throw new LeaseError("lease_scope_denied", "Runtime MCP requires exactly one leased connection.");
  }
  const connection = runtime.connections.visibleRecord(request.claims.connectionIds[0]);
  if (!connection) {
    throw new LeaseError("lease_scope_denied", "The leased connection is no longer visible.");
  }
  const actionId = request.claims.allowedActions[0];
  runtime.leases.verify(request.token, request.principal, {
    connectionId: connection.id,
    connectionRevision: connection.revision,
    actionId,
    invocationId: request.invocationId,
    audience: request.audience,
  });
  return connection;
}

async function recordRejectedExecution(
  runtime: TenantRuntime,
  request: LeaseRuntimeMcpContext,
  actionId: string,
  error: unknown,
): Promise<void> {
  const now = new Date().toISOString();
  const run: RunLog = {
    id: crypto.randomUUID(),
    invocationId: request.invocationId,
    service: actionId.split(".")[0] ?? "",
    actionId,
    caller: "mcp",
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    ok: false,
    connectionId: request.claims.connectionIds[0],
    errorCode: error instanceof LeaseError ? error.code : "unknown_action",
    errorMessage: "Runtime MCP execution was rejected.",
  };
  await runtime.runs.add(run).catch(() => undefined);
}

function executionMeta(run: ActionRunResult): Record<string, unknown> {
  return { executionId: run.executionId, auditPersisted: run.auditPersisted };
}

function success(data: unknown): Record<string, unknown> {
  return { ok: true, data };
}

function failure(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}

function leaseFailure(error: unknown): Record<string, unknown> {
  return error instanceof LeaseError
    ? failure(error.code, error.message)
    : failure("internal_error", "Runtime MCP request failed.");
}

function toolResult(payload: Record<string, unknown>): CallToolResult {
  const safe = boundedMcpValue(payload);
  return {
    content: [{ type: "text", text: JSON.stringify(safe) }],
    structuredContent: safe as Record<string, unknown>,
    ...(safe && typeof safe === "object" && "ok" in safe && safe.ok === false ? { isError: true } : {}),
  };
}

function boundedMcpValue(value: unknown): unknown {
  const safe = summarizeForRunLog(redactSecrets(value));
  const serialized = JSON.stringify(safe);
  return new TextEncoder().encode(serialized).byteLength <= maxOutputBytes
    ? safe
    : { ok: false, error: { code: "output_too_large", message: "MCP output exceeded the response limit." } };
}
