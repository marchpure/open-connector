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
import { executeWebAction } from "./web-action-runtime.ts";
import { TenantWebActionStore } from "./web-action-store.ts";

const maxOutputBytes = 64 * 1024;
const executionTimeoutMs = 30_000;
const leaseCheckIntervalMs = 100;

export interface LeaseRuntimeMcpContext {
  token: string;
  connectionId: string;
  invocationId: string;
  audience: string;
  claims: ConnectionLeaseClaims;
  principal: TenantPrincipal;
}

export function resolveLeaseRuntimeMcpContext(
  leases: ConnectionLeaseService,
  token: string | undefined,
  query: {
    connectionId: string | undefined;
    invocationId: string | undefined;
    audience: string | undefined;
  },
  headers: {
    connectionId?: string;
    invocationId?: string;
    audience?: string;
  } = {},
): LeaseRuntimeMcpContext {
  if (!token || !query.connectionId || !query.invocationId || !query.audience) {
    throw new LeaseError(
      "invalid_lease",
      "X-Connection-Lease and connectionId, invocationId, and audience query parameters are required.",
    );
  }
  if (
    (headers.connectionId !== undefined && headers.connectionId !== query.connectionId) ||
    (headers.invocationId !== undefined && headers.invocationId !== query.invocationId) ||
    (headers.audience !== undefined && headers.audience !== query.audience)
  ) {
    throw new LeaseError("lease_scope_denied", "MCP query and header scope parameters do not match.");
  }
  const claims = leases.resolve(token, {
    invocationId: query.invocationId,
    audience: query.audience,
  });
  if (!claims.connectionIds.includes(query.connectionId)) {
    throw new LeaseError("lease_scope_denied", "Connection lease does not grant the selected connection.");
  }
  return {
    token,
    connectionId: query.connectionId,
    invocationId: query.invocationId,
    audience: query.audience,
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
  const webActions = new TenantWebActionStore(
    deps.controlDatabase,
    request.principal,
    deps.secretCodec,
    deps.webEgress,
  );
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
    async () => toolResult(await listAllowedActions(deps, runtime, request)),
  );
  server.registerTool(
    "get_action_guide",
    {
      title: "Get Action Guide",
      description: "Get the bounded schema and usage details for one lease-allowed action.",
      inputSchema: { actionId: z.string().trim().min(1) },
    },
    async ({ actionId }) => toolResult(await getActionGuide(deps, runtime, request, actionId)),
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
    async ({ actionId, input }, context) =>
      toolResult(
        actionId.startsWith("web_api.")
          ? await executeDynamicWebAction(
              deps,
              webActions,
              runtime,
              request,
              actionId,
              input,
              AbortSignal.any([signal, context.mcpReq.signal]),
            )
          : await executeAction(
              deps.catalog,
              runtime,
              request,
              actionId,
              input,
              AbortSignal.any([signal, context.mcpReq.signal]),
            ),
      ),
  );
  return server;
}

async function executeDynamicWebAction(
  deps: ControlPlaneDependencies,
  webActions: TenantWebActionStore,
  runtime: TenantRuntime,
  request: LeaseRuntimeMcpContext,
  actionId: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const action = await webActions.get(actionId);
  if (!action || action.connectionId !== request.connectionId || !request.claims.allowedActions.includes(actionId)) {
    await recordRejectedExecution(
      runtime,
      request,
      actionId,
      new LeaseError("lease_scope_denied", "Web Action is not leased."),
    );
    return failure("lease_scope_denied", "Web Action is not granted by the current lease.");
  }
  const current = verifyCurrentLease(runtime, request);
  webActions.audit("tools_call", { connectionId: action.connectionId }, actionId, request.invocationId);
  const leaseAbort = new AbortController();
  const leaseWatch = setInterval(() => {
    try {
      runtime.leases.verifyConnection(request.token, request.principal, {
        connectionId: current.id,
        connectionRevision: current.revision,
        invocationId: request.invocationId,
        audience: request.audience,
      });
    } catch {
      leaseAbort.abort();
    }
  }, leaseCheckIntervalMs);
  let run: ActionRunResult;
  try {
    run = await executeWebAction({
      action,
      webActions,
      runs: runtime.runs,
      database: deps.controlDatabase,
      scope: { tenantId: request.principal.tenantId, workspaceId: request.principal.workspaceId },
      secretCodec: deps.secretCodec,
      invocationId: request.invocationId,
      input,
      signal: AbortSignal.any([signal, leaseAbort.signal]),
      webEgress: deps.webEgress,
    });
  } finally {
    clearInterval(leaseWatch);
  }
  try {
    runtime.leases.verifyConnection(request.token, request.principal, {
      connectionId: current.id,
      connectionRevision: current.revision,
      invocationId: request.invocationId,
      audience: request.audience,
    });
  } catch (error) {
    return leaseFailure(error);
  }
  webActions.audit("credential_use", { connectionId: action.connectionId }, actionId, request.invocationId);
  if (!run.result.ok) {
    webActions.audit(
      "failure",
      { connectionId: action.connectionId, errorCode: run.result.error?.code ?? "execution_failed" },
      actionId,
      request.invocationId,
    );
  }
  return run.result.ok
    ? { ok: true, data: run.result.output, ...executionMeta(run) }
    : { ok: false, error: run.result.error, ...executionMeta(run) };
}

export function assertLeaseRuntimeRequest(
  deps: ControlPlaneDependencies,
  request: LeaseRuntimeMcpContext,
): ConnectionRecord {
  const runtime = createTenantRuntime(deps, request.principal);
  const connection = verifyCurrentLease(runtime, request);
  const selectedActions = request.claims.allowedActions.filter((actionId) => {
    const action = deps.catalog.actionsById.get(actionId);
    return action?.service === connection.service && action.execution.locallyExecutable;
  });
  const dynamicActions = new TenantWebActionStore(
    deps.controlDatabase,
    request.principal,
    deps.secretCodec,
    deps.webEgress,
  )
    .actionIds(connection.id)
    .filter((actionId) => request.claims.allowedActions.includes(actionId));
  if (selectedActions.length === 0 && dynamicActions.length === 0) {
    throw new LeaseError("lease_scope_denied", "Lease grants no executable action for the selected connection.");
  }
  for (const actionId of selectedActions) {
    runtime.leases.verify(request.token, request.principal, {
      connectionId: connection.id,
      connectionRevision: connection.revision,
      actionId,
      invocationId: request.invocationId,
      audience: request.audience,
    });
  }
  for (const actionId of dynamicActions) {
    if (!actionId.startsWith("web_api.")) {
      throw new LeaseError("lease_scope_denied", "Lease grants an invalid Web Action.");
    }
  }
  return connection;
}

async function listAllowedActions(
  deps: ControlPlaneDependencies,
  runtime: TenantRuntime,
  request: LeaseRuntimeMcpContext,
): Promise<Record<string, unknown>> {
  try {
    const connection = verifyCurrentLease(runtime, request);
    webActionsFor(deps, request).audit("tools_list", { connectionId: connection.id }, undefined, request.invocationId);
    const dynamic = await new TenantWebActionStore(
      deps.controlDatabase,
      request.principal,
      deps.secretCodec,
      deps.webEgress,
    )
      .list(connection.id)
      .catch(() => []);
    return success({
      connectionId: connection.id,
      actions: request.claims.allowedActions.flatMap((actionId) => {
        const action = deps.catalog.actionsById.get(actionId);
        const webAction = dynamic.find((candidate) => candidate.id === actionId);
        return webAction && webAction.connectionId === connection.id
          ? [{ id: webAction.id, name: webAction.name, description: webAction.description }]
          : action && action.service === connection.service
            ? [{ id: action.id, name: action.name, description: action.description }]
            : [];
      }),
    });
  } catch (error) {
    return leaseFailure(error);
  }
}

async function getActionGuide(
  deps: ControlPlaneDependencies,
  runtime: TenantRuntime,
  request: LeaseRuntimeMcpContext,
  actionId: string,
): Promise<Record<string, unknown>> {
  try {
    const { action } = verifyAction(deps.catalog, runtime, request, actionId);
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
    if (actionId.startsWith("web_api.")) {
      const webActions = new TenantWebActionStore(
        deps.controlDatabase,
        request.principal,
        deps.secretCodec,
        deps.webEgress,
      );
      const action = await webActions.get(actionId);
      if (action && action.connectionId === request.connectionId && request.claims.allowedActions.includes(actionId)) {
        webActions.audit(
          "tools_get_action_guide",
          { connectionId: request.connectionId },
          actionId,
          request.invocationId,
        );
        return success({
          id: action.id,
          name: action.name,
          description: action.description,
          inputSchema: action.inputSchema,
          outputSchema: action.outputSchema,
          method: action.method,
          path: action.path,
          readOnly: action.readOnly,
          authentication: action.authentication,
          parameterSources: action.parameterSources,
          pagination: action.pagination,
          rateLimit: action.rateLimit,
          timeoutMs: action.timeoutMs,
          idempotency: action.idempotency,
          sideEffect: action.sideEffect,
        });
      }
    }
    return leaseFailure(error);
  }
}

function webActionsFor(deps: ControlPlaneDependencies, request: LeaseRuntimeMcpContext): TenantWebActionStore {
  return new TenantWebActionStore(deps.controlDatabase, request.principal, deps.secretCodec, deps.webEgress);
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
  const connection = runtime.connections.visibleRecord(request.connectionId);
  if (!connection) {
    throw new LeaseError("lease_scope_denied", "The leased connection is no longer visible.");
  }
  runtime.leases.verifyConnection(request.token, request.principal, {
    connectionId: connection.id,
    connectionRevision: connection.revision,
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
    connectionId: request.connectionId,
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
