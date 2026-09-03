import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary, ExecutionConnection } from "../../connection-service.ts";
import type {
  ActionPolicyDecision,
  ActionPolicyService,
  ActionPolicySnapshot,
  PolicyErrorCode,
} from "../../core/action-policy.ts";
import type {
  ActionDefinition,
  ExecutionActor,
  ExecutionContext,
  ExecutionResult,
  TransitFileWriter,
} from "../../core/types.ts";
import type { IProviderLoader } from "../../providers/provider-loader.ts";
import type { Logger } from "../logger.ts";
import type { IRunLogStore, RunLog, RunLogCaller, RunLogListInput, RunLogPage } from "../storage/runtime-store.ts";

import { ConnectionError } from "../../connection-service.ts";
import { executeAction as executeProviderAction } from "../../core/execution.ts";
import { safeRunLogError, summarizeForRunLog } from "./run-log-summary.ts";

export interface ActionRunnerOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  connections: ConnectionService;
  runs: IRunLogStore;
  transitFiles?: TransitFileWriter;
  actionPolicy?: ActionPolicyService;
  logger?: Logger;
  resourceAuthorization?: ResourceAuthorization;
}

export interface ResourceAuthorization {
  authorize(
    connectionId: string,
    service: string,
    actionId: string,
    input: unknown,
    bindings:
      | {
          required?: Record<string, readonly string[]>;
          optional?: Record<string, readonly string[]>;
        }
      | Record<string, readonly string[]>,
  ): { allowed: true } | { allowed: false; code: PolicyErrorCode; message: string };
}

export interface RunActionInput {
  actionId: string;
  invocationId?: string;
  input: unknown;
  caller: RunLogCaller;
  connectionName?: string;
  policy?: ActionPolicySnapshot;
  runtimeTokenId?: string;
  signal?: AbortSignal;
  /** Request-scoped credential resolver, used by external credential brokers. */
  getCredential?: ExecutionConnection["getCredential"];
  /** Verified caller identity propagated to provider runtimes. */
  actor?: ExecutionActor;
}

export interface ActionRunResult {
  executionId: string;
  auditPersisted: boolean;
  result: ExecutionResult;
  connection?: ConnectionSummary;
}

/**
 * Shared execution boundary for HTTP, MCP, and future local callers.
 */
export class ActionRunner {
  private readonly options: ActionRunnerOptions;

  constructor(options: ActionRunnerOptions) {
    this.options = options;
  }

  async run(input: RunActionInput): Promise<ActionRunResult | undefined> {
    const action = this.options.catalog.actionsById.get(input.actionId);
    if (!action) {
      this.options.logger?.warn(
        {
          actionId: input.actionId,
          caller: input.caller,
          errorCode: "unknown_action",
        },
        "action run rejected",
      );
      return undefined;
    }

    const executionId = crypto.randomUUID();
    const logContext = {
      actionId: action.id,
      service: action.service,
      caller: input.caller,
      executionId,
    };
    this.options.logger?.info(logContext, "action run started");
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const snapshot = input.policy ?? this.options.actionPolicy?.createSnapshot();
    let policy: ActionPolicyDecision = snapshot?.evaluate(action) ?? { allowed: true, checks: [] };
    let connection: ExecutionConnection | undefined;
    let auditConnectionId: string | undefined;
    let result: ExecutionResult;
    if (!policy.allowed) {
      result = { ok: false, error: { code: policy.code, message: policy.message } };
    } else if (input.signal?.aborted) {
      result = cancelledExecutionResult();
    } else {
      try {
        const summary = await this.options.connections.getConnectionSummary(action.service, input.connectionName);
        auditConnectionId = summary?.id;
        input.signal?.throwIfAborted();
        const connectionPolicy =
          summary?.authType === "no_auth" ? undefined : snapshot?.evaluateConnection(summary?.id);
        if (connectionPolicy && !connectionPolicy.allowed) {
          policy = connectionPolicy;
          result = { ok: false, error: { code: policy.code, message: policy.message } };
        } else if (summary && !hasRequiredScopes(action, summary)) {
          result = {
            ok: false,
            error: {
              code: "insufficient_scope",
              message: `${action.id} requires permissions not granted to this connection.`,
            },
          };
        } else {
          const resourcePolicy =
            summary?.id &&
            (action.resourceBindings || action.resourceBindingsOptional) &&
            (Object.keys(action.resourceBindings ?? {}).length > 0 ||
              Object.keys(action.resourceBindingsOptional ?? {}).length > 0) &&
            (this.options.resourceAuthorization?.authorize(
              summary.id,
              action.service,
              action.id,
              input.input,
              action.resourceBindingsOptional
                ? {
                    required: action.resourceBindings,
                    optional: action.resourceBindingsOptional,
                  }
                : action.resourceBindings!,
            ) ?? {
              allowed: false as const,
              code: "resource_not_discovered" as const,
              message: "Resource-bound actions require the tenant control-plane discovery allowlist.",
            });
          if (resourcePolicy && !resourcePolicy.allowed) {
            policy = {
              allowed: false,
              code: resourcePolicy.code,
              message: resourcePolicy.message,
              checks: [],
            };
            result = { ok: false, error: { code: resourcePolicy.code, message: resourcePolicy.message } };
          } else {
            connection = await this.options.connections.resolveForExecution(action.service, input.connectionName);
            input.signal?.throwIfAborted();
            const executor = action.execution.locallyExecutable
              ? await this.options.providerLoader.loadActionExecutor(
                  action.service,
                  action.id,
                  this.options.catalog.providers.find((provider) => provider.service === action.service)?.displayName,
                )
              : undefined;
            input.signal?.throwIfAborted();
            result = await executeProviderAction(
              action,
              executor,
              input.input,
              this.createExecutionContext(input.getCredential ?? connection.getCredential, input.signal, input.actor),
            );
            if (input.signal?.aborted) {
              result = cancelledExecutionResult();
            }
          }
        }
      } catch (error) {
        const missingConnectionPolicy =
          error instanceof ConnectionError && error.code === "connection_not_found"
            ? snapshot?.evaluateConnection()
            : undefined;
        if (input.signal?.aborted) {
          result = cancelledExecutionResult();
        } else if (missingConnectionPolicy && !missingConnectionPolicy.allowed) {
          policy = missingConnectionPolicy;
          result = { ok: false, error: { code: policy.code, message: policy.message } };
        } else {
          result =
            error instanceof ConnectionError
              ? { ok: false, error: { code: error.code, message: error.message } }
              : {
                  ok: false,
                  error: { code: "internal_error", message: "Action execution failed unexpectedly." },
                };
        }
      }
    }
    const completedAtMs = Date.now();
    const durationMs = completedAtMs - startedAtMs;
    const auditError = safeRunLogError(result.error);
    const runLog: RunLog = {
      id: executionId,
      invocationId: input.invocationId,
      service: action.service,
      actionId: input.actionId,
      caller: input.caller,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs,
      ok: result.ok,
      connectionId: connection?.summary?.id ?? auditConnectionId,
      connectionProfile: connection?.summary?.profile,
      runtimeTokenId: input.runtimeTokenId,
      policy,
      inputSummary: this.summarizeAuditValue(input.input, logContext),
      outputSummary: result.ok ? this.summarizeAuditValue(result.output, logContext) : undefined,
      ...auditError,
    };

    let auditPersisted = false;
    try {
      const write = await this.options.runs.add(runLog);
      auditPersisted = true;
      if (!write.retentionApplied) {
        this.options.logger?.warn({ ...logContext, auditPersisted }, "run audit retention failed");
      }
    } catch {
      this.options.logger?.warn({ ...logContext, auditPersisted }, "run audit persistence failed");
    }

    const completedLogContext = {
      ...logContext,
      connectionId: connection?.summary?.id ?? auditConnectionId,
      durationMs,
      ok: result.ok,
      errorCode: result.error?.code,
      auditPersisted,
    };
    if (result.ok) {
      this.options.logger?.info(completedLogContext, "action run completed");
    } else if (result.error?.code === "execution_cancelled") {
      this.options.logger?.info(completedLogContext, "action run cancelled");
    } else {
      this.options.logger?.warn(completedLogContext, "action run failed");
    }

    return { executionId, auditPersisted, result, connection: connection?.summary };
  }

  listRuns(input?: RunLogListInput): Promise<RunLogPage> {
    return this.options.runs.list(input);
  }

  getRun(id: string): Promise<RunLog | undefined> {
    return this.options.runs.get(id);
  }

  private createExecutionContext(
    getCredential: ExecutionConnection["getCredential"],
    signal: AbortSignal | undefined,
    actor: ExecutionActor | undefined,
  ): ExecutionContext {
    const context: ExecutionContext = {
      getCredential,
      signal,
      actor,
    };
    if (this.options.transitFiles) {
      context.transitFiles = this.options.transitFiles;
    }
    return context;
  }

  private summarizeAuditValue(value: unknown, logContext: Record<string, unknown>): unknown {
    try {
      return summarizeForRunLog(value);
    } catch {
      this.options.logger?.warn(logContext, "run audit summary unavailable");
      return "[unavailable]";
    }
  }
}

function hasRequiredScopes(action: ActionDefinition, connection: ConnectionSummary): boolean {
  if (!["tencent_docs", "wps_mcp", "baidu_netdisk"].includes(action.service)) return true;
  const granted = connection.profile.grantedScopes;
  if (granted.length === 0) return true;
  const required = connection.authType === "oauth2" ? action.providerPermissions : action.requiredScopes;
  return required.every((scope) => granted.includes(scope));
}

function cancelledExecutionResult(): ExecutionResult {
  return {
    ok: false,
    error: {
      code: "execution_cancelled",
      message: "Action execution was cancelled.",
    },
  };
}
