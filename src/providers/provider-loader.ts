import type {
  ActionExecutor,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../core/types.ts";

import { providerFetch, withProviderFallbackMessage } from "./provider-runtime.ts";

export interface ExecutorModule {
  credentialValidators?: CredentialValidators;
  executors: ProviderExecutors;
  proxy?: ProviderProxyExecutor;
  discoverResources?: (context: ExecutionContext, fetcher: typeof fetch) => Promise<ProviderResourceCandidate[]>;
}

export interface ProviderResourceCandidate {
  sourceType: "feishu" | "dingtalk" | "wecom";
  resourceId: string;
  resourceToken?: string;
  version?: string;
  etag?: string;
  title?: string;
  mimeType?: string;
  schema?: Record<string, unknown>;
  owner?: { id: string; displayName?: string };
  aclSummary?: { visibility: "private" | "shared" | "team"; subjectCount?: number };
  url?: string;
}

export interface ExecutorModules {
  [service: string]: () => Promise<ExecutorModule>;
}

/**
 * Loads provider executor modules only when an action is executed.
 *
 * Provider definitions are intentionally not exposed here. Runtime catalog
 * reads should use generated `catalog/apps/*.json` instead of importing
 * hundreds of provider definition modules at startup.
 */
export interface IProviderLoader {
  /**
   * Load one executor only when an action is being executed.
   */
  loadActionExecutor(
    service: string,
    actionId: string,
    providerDisplayName?: string,
  ): Promise<ActionExecutor | undefined>;

  /**
   * Load a provider proxy executor only when a proxy request is executed.
   */
  loadProxyExecutor(service: string, providerDisplayName?: string): Promise<ProviderProxyExecutor | undefined>;

  /**
   * Load a provider credential validator only when a connection is created.
   */
  loadCredentialValidators(service: string): Promise<CredentialValidators | undefined>;

  /**
   * Discover provider-owned resources only when the provider implements an
   * upstream visibility-aware discovery operation.
   */
  discoverResources?(
    service: string,
    context: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<ProviderResourceCandidate[]>;
}

/**
 * Provider loader backed by the executor registry selected by the runtime entry point.
 */
export class ProviderLoader implements IProviderLoader {
  private readonly executorModules: ExecutorModules;

  constructor(executorModules: ExecutorModules) {
    this.executorModules = executorModules;
  }

  async loadActionExecutor(
    service: string,
    actionId: string,
    providerDisplayName?: string,
  ): Promise<ActionExecutor | undefined> {
    const loadExecutors = this.executorModules[service];
    if (!loadExecutors) {
      return undefined;
    }

    const module = await loadExecutors();
    const executor = this._findActionExecutor(service, actionId, module.executors);
    return executor && providerDisplayName ? withProviderFallbackMessage(executor, providerDisplayName) : executor;
  }

  async loadProxyExecutor(service: string, _providerDisplayName?: string): Promise<ProviderProxyExecutor | undefined> {
    const loadExecutors = this.executorModules[service];
    if (!loadExecutors) {
      return undefined;
    }

    const module = await loadExecutors();
    return module.proxy;
  }

  async loadCredentialValidators(service: string): Promise<CredentialValidators | undefined> {
    const loadExecutors = this.executorModules[service];
    if (!loadExecutors) {
      return undefined;
    }

    const module = await loadExecutors();
    return module.credentialValidators;
  }

  async discoverResources(
    service: string,
    context: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<ProviderResourceCandidate[]> {
    const loadExecutors = this.executorModules[service];
    if (!loadExecutors) return [];
    const module = await loadExecutors();
    if (!module.discoverResources) return [];
    return module.discoverResources({ ...context, signal }, providerFetch);
  }

  private _findActionExecutor(
    service: string,
    actionId: string,
    executors: ProviderExecutors,
  ): ActionExecutor | undefined {
    if (!actionId.startsWith(`${service}.`)) {
      return undefined;
    }

    return executors[actionId as `${string}.${string}`];
  }
}
