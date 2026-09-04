import type { CatalogStore, RuntimeActionDefinition } from "../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../connection-service.ts";
import type { ActionPolicySnapshot } from "../core/action-policy.ts";
import type { ActionSearchIndexProvider, ActionSearchResult } from "../core/action-search.ts";
import type { MarketplaceConfigInput, MarketplaceService } from "../marketplace/marketplace-service.ts";
import type { OAuthClientConfigInput } from "../oauth/oauth-client-config-service.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { AccessGrantInput, IdentityProviderConfig } from "./access/access-grants.ts";
import type { LocalAuthOptions } from "./api/auth.ts";
import type { McpAuthorizer } from "./api/mcp-authorizer.ts";
import type { RuntimeActionHttpResult } from "./api/runtime-api.ts";
import type { ITransitFileService, TransitFileUpload } from "./files/transit-file-store.ts";
import type { Logger } from "./logger.ts";
import type { IIdempotencyStore } from "./storage/idempotency-store.ts";
import type { IRuntimePolicyStore } from "./storage/runtime-policy-store.ts";
import type { RunLogCaller, RunLogListInput } from "./storage/runtime-store.ts";
import type { RuntimeGrant, RuntimeTokenService } from "./storage/runtime-token-service.ts";
import type { Context } from "hono";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { ConnectionError, defaultConnectionName } from "../connection-service.ts";
import { ActionPolicyService, emptyPolicyRules } from "../core/action-policy.ts";
import { DEFAULT_ACTION_SEARCH_LIMIT, createActionSearchIndexProvider, searchActions } from "../core/action-search.ts";
import { optionalRecord, optionalString, requiredString, requiredStringArray } from "../core/cast.ts";
import { MarketplaceError } from "../marketplace/marketplace-service.ts";
import { createMcpServer, listAuthorizedMcpToolSummaries } from "../mcp.ts";
import { OAuthClientConfigError, OAuthClientConfigService } from "../oauth/oauth-client-config-service.ts";
import { OAuthFlowError, OAuthFlowService } from "../oauth/oauth-flow-service.ts";
import { AccessGrantService } from "./access/access-grants.ts";
import {
  ActionInputDepthError,
  createIdempotencyExpiry,
  hashActionRequest,
  hashIdempotencyKey,
  readIdempotencyKey,
} from "./actions/action-idempotency.ts";
import { ActionRunner } from "./actions/action-runner.ts";
import { renderActionMarkdown } from "./api/action-markdown.ts";
import {
  clearLocalAuthCookie,
  createLocalAuthMiddleware,
  readLocalAuthSession,
  readRuntimeAuthContext,
  readRuntimeGrant,
  readRuntimeSubject,
} from "./api/auth.ts";
import { getResponseCachePolicy } from "./api/cache-policy.ts";
import { HttpRequestError, internalError, jsonError, notFound, readJsonBody } from "./api/http-utils.ts";
import { mcpM2mAuthorizer } from "./api/mcp-authorizer.ts";
import { renderOAuthCompletionPage } from "./api/oauth-completion-page.ts";
import { createOpenApiDocument } from "./api/openapi.ts";
import { policyRequestMaxBytes, readRuntimePolicyRules, readTokenPolicy } from "./api/policy-input.ts";
import {
  mapConnectionErrorStatus,
  serializeRuntimeAction,
  serializeRuntimeActionResult,
  serializeRuntimeActionService,
  serializeRuntimeConnectedApp,
  serializeRuntimeFailure,
  serializeRuntimeProvider,
  unknownActionFailure,
  writeRuntimeActionHttpResult,
  writeRuntimeFailure,
  writeRuntimeSuccess,
} from "./api/runtime-api.ts";
import { createTransitFileResponse, TransitFileError } from "./files/transit-file-store.ts";
import { ProxyRunner } from "./proxy/proxy-runner.ts";
import { decodeRunLogCursor } from "./storage/runtime-store.ts";
import { summarizeRuntimeToken } from "./storage/runtime-token-service.ts";

export type ConnectServerRole = "all" | "control-plane" | "mcp-runtime";

/**
 * Dependencies required to construct the local connector server.
 */
export interface IConnectServerOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  connections: ConnectionService;
  oauthClientConfigs: OAuthClientConfigService;
  oauthFlow: OAuthFlowService;
  runtimeTokens: RuntimeTokenService;
  actions: ActionRunner;
  idempotency: IIdempotencyStore;
  transitFiles: ITransitFileService;
  uploadTransitFile?: (request: Request) => Promise<TransitFileUpload>;
  staticRoot?: string;
  auth?: LocalAuthOptions;
  actionPolicy?: ActionPolicyService;
  runtimePolicyStore: IRuntimePolicyStore;
  actionSearch?: ActionSearchIndexProvider;
  accessGrants?: AccessGrantService;
  registerStaticRoutes?: (app: Hono) => void;
  logger?: Logger;
  compressApiResponses?: boolean;
  marketplace?: MarketplaceService;
  mcpAuthorizer?: McpAuthorizer;
  role?: ConnectServerRole;
}

/**
 * Local single-user HTTP server for catalog browsing, credential management,
 * action execution, OpenAPI docs, and MCP tool metadata.
 */
export class ConnectServer {
  private readonly options: IConnectServerOptions;
  private readonly actionSearch: ActionSearchIndexProvider;
  private readonly actionPolicy: ActionPolicyService;
  private readonly proxyRunner: ProxyRunner;
  private readonly policySnapshots = new WeakMap<Request, Promise<ActionPolicySnapshot>>();

  constructor(options: IConnectServerOptions) {
    this.options = options;
    this.actionSearch = options.actionSearch ?? createActionSearchIndexProvider(options.catalog.actions);
    this.actionPolicy = options.actionPolicy ?? new ActionPolicyService();
    this.proxyRunner = new ProxyRunner({
      catalog: options.catalog,
      providerLoader: options.providerLoader,
      connections: options.connections,
      actionPolicy: this.actionPolicy,
      logger: options.logger,
    });
  }

  createApp(): Hono {
    const app = new Hono();
    const auth = this.options.auth ?? {};
    const role = this.options.role ?? "all";
    const controlPlaneEnabled = role === "all" || role === "control-plane";
    const runtimeEnabled = role === "all" || role === "mcp-runtime";

    app.use("*", async (context, next) => {
      await next();
      const cachePolicy = getResponseCachePolicy(context.req.method, context.req.path, context.res.status);
      if (cachePolicy) {
        context.header("Cache-Control", cachePolicy.cacheControl);
        if (cachePolicy.cloudflareCdnCacheControl) {
          context.header("Cloudflare-CDN-Cache-Control", cachePolicy.cloudflareCdnCacheControl);
        }
        if (cachePolicy.vary) {
          context.header("Vary", cachePolicy.vary);
        }
      }
    });
    app.get("/health", (context) => context.json({ ok: true }));
    if (this.options.compressApiResponses !== false) {
      // Compress dashboard JSON responses. Scoped to /api/* so the streaming
      // /mcp transport and /v1/proxy pass-through are never buffered/re-encoded.
      // The middleware's content-type filter already skips non-text bodies
      // (e.g. transit file downloads).
      app.use("/api/*", compress());
    }
    app.use("*", createLocalAuthMiddleware(auth));
    if (controlPlaneEnabled && this.options.marketplace) {
      app.get("/api/marketplace", (context) => context.json(this.options.marketplace!.getState()));
      app.put("/api/marketplace", (context) => this.configureMarketplace(context));
      app.patch("/api/marketplace", (context) => this.configureMarketplace(context));
      app.delete("/api/marketplace", (context) => this.deleteMarketplace(context));
      app.get("/api/provider-preferences", async (context) =>
        context.json(await this.options.marketplace!.listProviderPreferences()),
      );
      app.patch("/api/provider-preferences/:service", (context) =>
        this.updateProviderPreference(context, context.req.param("service")),
      );
    }
    if (runtimeEnabled) {
      app.get("/v1/health", (context) => writeRuntimeSuccess(context, { ok: true, runtime: "oomol-connect" }));
      app.get("/v1/providers", (context) => this.listRuntimeProviders(context));
      app.get("/v1/actions", (context) => this.listRuntimeActions(context));
      app.get("/v1/actions/search", (context) => this.searchRuntimeActions(context));
      app.get("/v1/actions/:actionId", (context) => this.getRuntimeAction(context, context.req.param("actionId")));
      app.post("/v1/actions/:actionId", (context) =>
        this.createRuntimeActionRun(context, context.req.param("actionId")),
      );
      app.get("/v1/apps", (context) => this.listRuntimeApps(context));
      app.get("/v1/apps/authenticated", (context) => this.listAuthenticatedRuntimeApps(context));
      app.get("/v1/apps/services/:service", (context) =>
        this.listRuntimeAppsByService(context, context.req.param("service")),
      );
      app.post("/v1/proxy/:service", (context) =>
        this.createRuntimeProxyRequest(context, context.req.param("service")),
      );
      app.post("/mcp", (context) => this.handleMcp(context));
      app.get("/mcp", (context) => this.rejectMcpMethod(context));
      app.delete("/mcp", (context) => this.rejectMcpMethod(context));
      app.get("/mcp/tools", async (context) =>
        context.json({
          tools: await listAuthorizedMcpToolSummaries(this.mcpAuthorizer, {
            auth: readRuntimeAuthContext(context),
          }),
        }),
      );
    }

    if (controlPlaneEnabled) {
      app.get("/v1/access-grants", (context) => this.listAccessGrants(context));
      app.post("/v1/access-grants", (context) => this.createAccessGrant(context));
      app.patch("/v1/access-grants/:id", (context) => this.updateAccessGrant(context, context.req.param("id")));
      app.post("/v1/access-grants/:id\\:revoke", (context) =>
        this.revokeAccessGrant(context, readColonActionAccessGrantId(context)),
      );
      app.post("/v1/access-grants/:id/revoke", (context) => this.revokeAccessGrant(context, context.req.param("id")));
      app.post("/v1/access:preview", (context) => this.previewAccess(context));
      app.get("/v1/access/audit", (context) => this.listAccessAudit(context));
      app.get("/v1/identity/subjects", (context) => this.listIdentitySubjects(context));
      app.get("/openapi.json", (context) =>
        context.json(
          createOpenApiDocument(this.options.catalog.providers, {
            actionId: optionalString(context.req.query("actionId")),
          }),
        ),
      );
      app.get(
        "/docs",
        Scalar({
          pageTitle: "OOMOL Connect API Reference",
          url: "/openapi.json",
          theme: "default",
          darkMode: false,
          forceDarkModeState: "light",
          customCss: `
            :root {
              --scalar-color-accent: rgb(59, 99, 251);
              --scalar-background-accent: rgba(59, 99, 251, 0.12);
            }
          `,
        }),
      );

      // Schema-free listing. The action detail view loads full schemas on demand
      // from /api/actions/:actionId. The catalog is immutable at runtime, so the
      // body and its ETag are precomputed and reused, and unchanged reloads get a
      // 304 instead of re-downloading the payload.
      app.get("/api/providers", (context) => this.listProviderSummaries(context));
      app.get("/api/providers/:service", (context) => this.getProvider(context, context.req.param("service")));

      app.get("/api/actions", (context) => context.json(this.options.catalog.actions));
      app.get("/api/actions/search", (context) => this.searchApiActions(context));
      app.get("/api/actions/:actionId/agent.md", (context) =>
        this.getActionMarkdown(context, context.req.param("actionId")),
      );
      app.get("/api/actions/:actionId", (context) => this.getAction(context, context.req.param("actionId")));
      app.get("/api/auth/session", async (context) => context.json(await readLocalAuthSession(context, auth)));
      app.post("/api/auth/logout", (context) => {
        clearLocalAuthCookie(context);
        return context.json({ ok: true });
      });

      app.get("/api/connections", (context) => this.listConnections(context));
      app.put("/api/connections/:service", (context) => this.upsertConnection(context, context.req.param("service")));
      app.delete("/api/connections/:service", (context) => this.disconnect(context, context.req.param("service")));

      app.get("/api/runs", (context) => this.listRuns(context));
      app.get("/api/runs/:id", (context) => this.getRun(context, context.req.param("id")));
      app.post("/api/files", (context) => this.createTransitFile(context));
      app.get("/api/files/:fileId", (context) => this.getTransitFile(context, context.req.param("fileId")));
      app.delete("/api/files/:fileId", (context) => this.deleteTransitFile(context, context.req.param("fileId")));
      app.get("/api/runtime-tokens", (context) => this.listRuntimeTokens(context));
      app.post("/api/runtime-tokens", (context) => this.createRuntimeToken(context));
      app.put("/api/runtime-tokens/:id", (context) => this.updateRuntimeToken(context, context.req.param("id")));
      app.delete("/api/runtime-tokens/:id", (context) => this.revokeRuntimeToken(context, context.req.param("id")));
      app.get("/api/runtime-policy", (context) => this.getRuntimePolicy(context));
      app.put("/api/runtime-policy", (context) => this.updateRuntimePolicy(context));
      app.get("/api/identity-provider", (context) => this.getIdentityProviderConfig(context));
      app.put("/api/identity-provider", (context) => this.updateIdentityProviderConfig(context));
      app.get("/api/access-grants", (context) => this.listAccessGrants(context));
      app.post("/api/access-grants", (context) => this.createAccessGrant(context));
      app.patch("/api/access-grants/:id", (context) => this.updateAccessGrant(context, context.req.param("id")));
      app.post("/api/access-grants/:id/revoke", (context) => this.revokeAccessGrant(context, context.req.param("id")));
      app.post("/api/access/preview", (context) => this.previewAccess(context));
      app.get("/api/access/audit", (context) => this.listAccessAudit(context));
      app.get("/api/identity/subjects", (context) => this.listIdentitySubjects(context));
      app.get("/api/oauth/configs", (context) => this.listOAuthConfigs(context));
      app.put("/api/oauth/configs/:service", (context) =>
        this.upsertOAuthConfig(context, context.req.param("service")),
      );
      app.delete("/api/oauth/configs/:service", (context) =>
        this.deleteOAuthConfig(context, context.req.param("service")),
      );
      app.post("/api/oauth/authorizations", (context) => this.createOAuthAuthorization(context));
      app.get("/oauth/callback", (context) => this.completeOAuth(context));
    } else if (runtimeEnabled) {
      app.get("/api/files/:fileId", (context) => this.getTransitFile(context, context.req.param("fileId")));
    }

    this.options.registerStaticRoutes?.(app);
    app.onError((error, context) => {
      if (error instanceof HttpRequestError) {
        if (context.req.path.startsWith("/v1/")) {
          return writeRuntimeFailure(context, {
            status: error.status,
            errorCode: error.code,
            message: error.message,
          });
        }
        return jsonError(context, error.status, error.code, error.message);
      }
      this.options.logger?.error(
        {
          err: error,
          method: context.req.method,
          path: context.req.path,
        },
        "request failed",
      );
      return internalError(context, error);
    });

    return app;
  }

  private listProviderSummaries(context: Context): Response {
    const { providerSummariesJson, providerSummariesEtag } = this.options.catalog;
    context.header("ETag", providerSummariesEtag);
    if (requestMatchesEtag(context.req.header("If-None-Match"), providerSummariesEtag)) {
      return context.body(null, 304);
    }
    return context.body(providerSummariesJson, 200, { "Content-Type": "application/json" });
  }

  private async configureMarketplace(context: Context): Promise<Response> {
    const body = await readJsonBody(context);
    const input: MarketplaceConfigInput = {
      discoveryUrl: optionalString(body.discoveryUrl),
      apiKey: optionalString(body.apiKey),
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    };
    try {
      return context.json(await this.options.marketplace!.configure(input));
    } catch (error) {
      if (error instanceof MarketplaceError) {
        return jsonError(context, error.status === 404 ? 404 : 400, error.code, error.message);
      }
      throw error;
    }
  }

  private async deleteMarketplace(context: Context): Promise<Response> {
    await this.options.marketplace!.remove();
    return context.json(this.options.marketplace!.getState());
  }

  private async updateProviderPreference(context: Context, service: string): Promise<Response> {
    const body = await readJsonBody(context);
    if (typeof body.enabled !== "boolean") {
      return jsonError(context, 400, "invalid_input", "enabled must be a boolean.");
    }
    try {
      return context.json(await this.options.marketplace!.setProviderEnabled(service, body.enabled));
    } catch (error) {
      if (error instanceof MarketplaceError) return jsonError(context, 404, error.code, error.message);
      throw error;
    }
  }

  private getProvider(context: Context, service: string): Response {
    const provider = this.options.catalog.providers.find((provider) => provider.service === service);
    if (!provider) {
      return notFound(context);
    }

    return context.json(provider);
  }

  private async createTransitFile(context: Context): Promise<Response> {
    try {
      if (this.options.uploadTransitFile) {
        return context.json(await this.options.uploadTransitFile(context.req.raw));
      }

      const form = await context.req.raw.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return jsonError(context, 400, "invalid_input", "file is required.");
      }
      const upload = await this.options.transitFiles.create(file);
      return context.json(upload);
    } catch (error) {
      return this.handleTransitFileError(context, error);
    }
  }

  private async getTransitFile(context: Context, fileId: string): Promise<Response> {
    try {
      if (this.options.transitFiles.response) {
        return await this.options.transitFiles.response(fileId);
      }

      const file = await this.options.transitFiles.read(fileId);
      return createTransitFileResponse(file);
    } catch (error) {
      return this.handleTransitFileError(context, error);
    }
  }

  private async deleteTransitFile(context: Context, fileId: string): Promise<Response> {
    try {
      const deleted = await this.options.transitFiles.delete(fileId);
      return context.json({ fileId, deleted });
    } catch (error) {
      return this.handleTransitFileError(context, error);
    }
  }

  private handleTransitFileError(context: Context, error: unknown): Response {
    if (error instanceof TransitFileError) {
      return jsonError(context, error.status, error.code, error.message);
    }
    throw error;
  }

  private getAction(context: Context, actionId: string): Response {
    const action = this.options.catalog.actionsById.get(actionId);
    if (!action) {
      return notFound(context);
    }

    return context.json(action);
  }

  private async listRuns(context: Context): Promise<Response> {
    const query = readRunLogListInput(context);
    if (!query.ok) {
      return jsonError(context, 400, "invalid_input", query.message);
    }

    return context.json(await this.options.actions.listRuns(query.input));
  }

  private async getRun(context: Context, id: string): Promise<Response> {
    const run = await this.options.actions.getRun(id);
    return run ? context.json(run) : jsonError(context, 404, "run_not_found", `Run not found: ${id}.`);
  }

  private async searchApiActions(context: Context): Promise<Response> {
    const query = readSearchQuery(context);
    if (!query.ok) {
      return jsonError(context, 400, "invalid_input", query.message);
    }

    const index = await this.actionSearch.get();
    return context.json(
      await this.serializeSearchResults(
        context,
        searchActions(index, query.q, {
          service: query.service,
          limit: query.limit,
        }),
        false,
      ),
    );
  }

  private async getActionMarkdown(context: Context, actionId: string): Promise<Response> {
    const action = this.options.catalog.actionsById.get(actionId);
    if (!action) {
      return notFound(context);
    }

    try {
      const policy = (await this.getPolicySnapshot(context)).evaluate(action);
      return context.text(
        renderActionMarkdown(action, {
          connection: await this.options.connections.getConnectionSummary(action.service, readConnectionName(context)),
          providerPermissions: action.providerPermissions,
          policy,
        }),
        200,
        {
          "content-type": "text/markdown; charset=utf-8",
        },
      );
    } catch (error) {
      if (error instanceof ConnectionError) {
        const status = mapConnectionErrorStatus(error);
        // agent.md uses the admin JSON error envelope; mapConnectionErrorStatus may
        // return 409 for OAuth refresh failures, which jsonError does not accept.
        if (status === 409) {
          return context.json({ error: { code: error.code, message: error.message } }, 409);
        }
        return jsonError(context, status, error.code, error.message);
      }
      throw error;
    }
  }

  private listRuntimeProviders(context: Context): Response {
    const services = context.req.queries("service") ?? [];
    const query = optionalString(context.req.query("q"))?.toLowerCase();
    const providers = this.options.catalog.providers.filter((provider) => {
      if (services.length > 0 && !services.includes(provider.service)) {
        return false;
      }
      if (!query) {
        return true;
      }

      return [
        provider.service,
        provider.displayName,
        provider.categories.join(" "),
        provider.scenario,
        provider.authTypes.join(" "),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return writeRuntimeSuccess(context, providers.map(serializeRuntimeProvider));
  }

  private async listRuntimeActions(context: Context): Promise<Response> {
    const service = optionalString(context.req.query("service"));
    if (!service) {
      const actions = await this.allowedRuntimeActions(context, this.options.catalog.actions);
      const services = [...new Set(actions.map((action) => action.service))];
      return writeRuntimeSuccess(context, services.map(serializeRuntimeActionService));
    }

    const actions = await this.allowedRuntimeActions(
      context,
      this.options.catalog.actions.filter((action) => action.service === service),
    );
    return writeRuntimeSuccess(context, actions.map(serializeRuntimeAction));
  }

  private async searchRuntimeActions(context: Context): Promise<Response> {
    const query = readSearchQuery(context, 10);
    if (!query.ok) {
      return writeRuntimeFailure(context, {
        status: 400,
        errorCode: "invalid_input",
        message: query.message,
      });
    }

    const index = await this.actionSearch.get();
    const results = searchActions(index, query.q, {
      service: query.service,
      limit: query.limit,
    });
    return writeRuntimeSuccess(context, await this.serializeSearchResults(context, results));
  }

  private async serializeSearchResults(
    context: Context,
    results: ActionSearchResult[],
    filterByAccess = true,
  ): Promise<RuntimeActionSearchResult[]> {
    const authenticated = new Set(
      await this.options.connections.listAuthenticatedServices([...new Set(results.map((result) => result.service))]),
    );
    const allowedActions = filterByAccess
      ? new Set(
          (
            await this.allowedRuntimeActions(
              context,
              results.flatMap((result) => {
                const action = this.options.catalog.actionsById.get(result.id);
                return action ? [action] : [];
              }),
            )
          ).map((action) => action.id),
        )
      : undefined;
    return results.flatMap((result) => {
      const action = this.options.catalog.actionsById.get(result.id);
      if (!action || (allowedActions && !allowedActions.has(action.id))) {
        return [];
      }
      return [serializeActionSearchResult(result, action, authenticated.has(action.service))];
    });
  }

  private getRuntimeAction(context: Context, actionId: string): Response {
    const action = this.options.catalog.actionsById.get(actionId);
    if (!action) {
      return writeRuntimeFailure(context, unknownActionFailure(actionId));
    }

    return writeRuntimeSuccess(context, serializeRuntimeAction(action));
  }

  private async createRuntimeActionRun(context: Context, actionId: string): Promise<Response> {
    const action = this.options.catalog.actionsById.get(actionId);
    if (!action) {
      return writeRuntimeFailure(context, unknownActionFailure(actionId));
    }

    const body = await readJsonBody(context);
    const input = body.input ?? {};
    const connectionName = readConnectionName(context, body);
    const runtimeGrant = readRuntimeGrant(context);
    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
        meta: { actionId },
      });
    }
    const selectedConnection = await this.resolveRuntimeConnectionForPolicy(
      context,
      action.service,
      connectionName,
      actionId,
    );
    if (selectedConnection instanceof Response) {
      return selectedConnection;
    }
    if (!policy.evaluateActionForConnection(action, selectedConnection?.id).allowed) {
      return writeRuntimeActionHttpResult(
        context,
        await this.executeRuntimeAction(actionId, input, connectionName, policy, runtimeGrant, context.req.raw.signal),
      );
    }
    const idempotencyKey = readIdempotencyKey(context.req.header("idempotency-key"));
    if (!idempotencyKey.ok) {
      return writeRuntimeFailure(context, {
        status: 400,
        errorCode: "invalid_input",
        message: idempotencyKey.message,
        meta: { actionId },
      });
    }

    if (!idempotencyKey.key) {
      return writeRuntimeActionHttpResult(
        context,
        await this.executeRuntimeAction(actionId, input, connectionName, policy, runtimeGrant, context.req.raw.signal),
      );
    }

    const now = new Date();
    const keyHash = hashIdempotencyKey(idempotencyKey.key);
    let requestHash: string;
    try {
      requestHash = hashActionRequest({
        actionId,
        connectionName: connectionName ?? defaultConnectionName,
        input,
        runtimeTokenId: runtimeGrant?.tokenId,
      });
    } catch (error) {
      if (!(error instanceof ActionInputDepthError)) {
        throw error;
      }
      return writeRuntimeFailure(context, {
        status: 400,
        errorCode: "invalid_input",
        message: error.message,
        meta: { actionId },
      });
    }
    const claimId = crypto.randomUUID();
    const claim = await this.options.idempotency.claim({
      keyHash,
      requestHash,
      claimId,
      now: now.toISOString(),
      expiresAt: createIdempotencyExpiry(now),
    });

    if (claim.kind === "conflict") {
      return writeRuntimeFailure(context, {
        status: 409,
        errorCode: "idempotency_key_conflict",
        message: "Idempotency-Key has already been used with a different request.",
        meta: { actionId },
      });
    }
    if (claim.kind === "in_progress") {
      return writeRuntimeFailure(context, {
        status: 409,
        errorCode: "idempotency_request_in_progress",
        message: "A request with this Idempotency-Key is still in progress.",
        meta: { actionId },
      });
    }
    if (claim.kind === "completed") {
      return writeRuntimeActionHttpResult(context, claim.response);
    }

    const result = await this.executeRuntimeAction(
      actionId,
      input,
      connectionName,
      policy,
      runtimeGrant,
      context.req.raw.signal,
    );
    const completed = await this.options.idempotency.complete({
      keyHash,
      requestHash,
      claimId,
      response: result,
      expiresAt: createIdempotencyExpiry(new Date()),
    });
    if (!completed) {
      throw new Error("Idempotency claim was replaced before completion.");
    }

    return writeRuntimeActionHttpResult(context, result);
  }

  private async executeRuntimeAction(
    actionId: string,
    input: unknown,
    connectionName: string | undefined,
    policy: ActionPolicySnapshot,
    runtimeGrant: RuntimeGrant | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RuntimeActionHttpResult> {
    try {
      const run = await this.options.actions.run({
        actionId,
        input,
        caller: "http",
        connectionName,
        policy,
        runtimeTokenId: runtimeGrant?.tokenId,
        signal,
      });
      if (!run) {
        return serializeRuntimeFailure(unknownActionFailure(actionId));
      }

      return serializeRuntimeActionResult({
        actionId,
        executionId: run.executionId,
        auditPersisted: run.auditPersisted,
        result: run.result,
      });
    } catch (error) {
      if (error instanceof ConnectionError) {
        return serializeRuntimeFailure({
          status: mapConnectionErrorStatus(error),
          errorCode: error.code,
          message: error.message,
          meta: { actionId },
        });
      }

      throw error;
    }
  }

  private async createRuntimeProxyRequest(context: Context, service: string): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(context);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        return writeRuntimeFailure(context, {
          status: error.status,
          errorCode: error.code,
          message: error.message,
          meta: { service },
        });
      }

      throw error;
    }

    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
        meta: { service },
      });
    }
    const result = await this.proxyRunner.run({
      service,
      input: body,
      connectionName: readConnectionName(context, body),
      policy,
    });
    if (result.ok) {
      return writeRuntimeSuccess(context, result.response);
    }

    return writeRuntimeFailure(context, {
      status: result.status,
      errorCode: result.errorCode,
      message: result.message,
      data: result.data,
      meta: result.meta,
    });
  }

  private async listRuntimeApps(context: Context): Promise<Response> {
    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
      });
    }
    return writeRuntimeSuccess(
      context,
      this.filterAllowedConnections(policy, await this.options.connections.listConnections()).map(
        serializeRuntimeConnectedApp,
      ),
    );
  }

  private async listRuntimeAppsByService(context: Context, service: string): Promise<Response> {
    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
        meta: { service },
      });
    }
    try {
      return writeRuntimeSuccess(
        context,
        this.filterAllowedConnections(policy, await this.options.connections.listConnectionsByService(service)).map(
          serializeRuntimeConnectedApp,
        ),
      );
    } catch (error) {
      if (error instanceof ConnectionError) {
        return writeRuntimeFailure(context, {
          status: mapConnectionErrorStatus(error),
          errorCode: error.code,
          message: error.message,
          meta: { service },
        });
      }

      throw error;
    }
  }

  private async listAuthenticatedRuntimeApps(context: Context): Promise<Response> {
    const services = context.req.queries("service") ?? [];
    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
      });
    }
    const authenticated = new Set(
      this.filterAllowedConnections(policy, await this.options.connections.listConnections())
        .filter((connection) => connection.configured && connection.authType !== "no_auth")
        .map((connection) => connection.service),
    );
    return writeRuntimeSuccess(
      context,
      services.filter((service) => authenticated.has(service)),
    );
  }

  private filterAllowedConnections(
    policy: ActionPolicySnapshot,
    connections: ConnectionSummary[],
  ): ConnectionSummary[] {
    return connections.filter(
      (connection) => connection.authType === "no_auth" || policy.evaluateConnection(connection.id).allowed,
    );
  }

  private async allowedRuntimeActions(
    context: Context,
    actions: RuntimeActionDefinition[],
  ): Promise<RuntimeActionDefinition[]> {
    if (!readRuntimeSubject(context)) {
      return actions;
    }
    const policy = await this.getPolicySnapshot(context);
    const connectionsByService = new Map<string, ConnectionSummary[]>();
    for (const connection of this.filterAllowedConnections(policy, await this.options.connections.listConnections())) {
      connectionsByService.set(connection.service, [
        ...(connectionsByService.get(connection.service) ?? []),
        connection,
      ]);
    }
    return actions.filter((action) =>
      (connectionsByService.get(action.service) ?? []).some(
        (connection) => policy.evaluateActionForConnection(action, connection.id).allowed,
      ),
    );
  }

  private async handleMcp(context: Context): Promise<Response> {
    const subject = { auth: readRuntimeAuthContext(context), identity: readRuntimeSubject(context) };
    const handler = createMcpHandler(
      () =>
        createMcpServer({
          catalog: this.options.catalog,
          providerLoader: this.options.providerLoader,
          connections: this.options.connections,
          actions: this.options.actions,
          actionPolicy: this.actionPolicy,
          actionSearch: this.actionSearch,
          getPolicySnapshot: () => this.getPolicySnapshot(context),
          runtimeGrant: readRuntimeGrant(context),
          authorizer: this.mcpAuthorizer,
          authorizationSubject: subject,
          signal: context.req.raw.signal,
        }),
      { legacy: "stateless", responseMode: "json" },
    );
    try {
      return await handler.fetch(context.req.raw);
    } finally {
      await handler.close();
    }
  }

  private get mcpAuthorizer(): McpAuthorizer {
    return this.options.mcpAuthorizer ?? mcpM2mAuthorizer;
  }

  private rejectMcpMethod(context: Context): Response {
    return context.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      },
      405,
    );
  }

  private async listConnections(context: Context): Promise<Response> {
    return context.json(await this.options.connections.listConnections());
  }

  private async upsertConnection(context: Context, service: string): Promise<Response> {
    const body = await readJsonBody(context);
    const authType = optionalString(body.authType);
    if (!authType) {
      this.options.logger?.warn(
        {
          errorCode: "invalid_input",
          path: context.req.path,
          service,
        },
        "connection rejected",
      );
      return jsonError(context, 400, "invalid_input", "authType is required.");
    }

    const values = body.values ?? body;
    const connectionName = readConnectionName(context, body);
    const logContext: ConnectionLogContext = {
      operation: "connect",
      path: context.req.path,
      service,
      authType,
      connectionName,
    };
    if (authType === "no_auth") {
      this.options.logger?.info(logContext, "connection started");
      return this.writeConnectionResult(
        context,
        this.options.connections.connectWithoutAuth(service, { connectionName }),
        logContext,
      );
    }
    if (authType === "api_key") {
      this.options.logger?.info(logContext, "connection started");
      return this.writeConnectionResult(
        context,
        this.options.connections.connectWithApiKey(service, {
          values,
          connectionName,
          signal: context.req.raw.signal,
        }),
        logContext,
      );
    }
    if (authType === "custom_credential") {
      this.options.logger?.info(logContext, "connection started");
      return this.writeConnectionResult(
        context,
        this.options.connections.connectWithCustomCredential(service, {
          values,
          connectionName,
          signal: context.req.raw.signal,
        }),
        logContext,
      );
    }

    this.options.logger?.warn(
      {
        ...logContext,
        errorCode: "unsupported_auth_type",
      },
      "connection rejected",
    );
    return jsonError(context, 400, "unsupported_auth_type", `${service} does not support ${authType}.`);
  }

  private async disconnect(context: Context, service: string): Promise<Response> {
    const body = context.req.header("content-type")?.includes("application/json") ? await readJsonBody(context) : {};
    const connectionName = readConnectionName(context, body);
    const logContext: ConnectionLogContext = {
      operation: "disconnect",
      path: context.req.path,
      service,
      connectionName,
    };
    this.options.logger?.info(logContext, "connection disconnect started");
    return this.writeConnectionResult(
      context,
      this.options.connections.disconnect(service, connectionName),
      logContext,
    );
  }

  private async createOAuthAuthorization(context: Context): Promise<Response> {
    const body = await readJsonBody(context);
    const requestedService = optionalString(body.service);
    const connectionName = readConnectionName(context, body);
    try {
      const service = requiredString(
        body.service,
        "service",
        (message) => new OAuthFlowError("invalid_input", message),
      );
      const logContext = {
        path: context.req.path,
        service,
        connectionName,
      };
      this.options.logger?.info(logContext, "oauth authorization started");

      const authorization = await this.options.oauthFlow.startAuthorization({
        service,
        connectionName,
        clientConfig: readOAuthClientConfigInput(body),
      });
      const authorizationUrl = new URL(authorization.authorizationUrl);
      this.options.logger?.info(
        {
          ...logContext,
          authorizationHost: authorizationUrl.host,
          redirectUri: authorizationUrl.searchParams.get("redirect_uri") ?? undefined,
        },
        "oauth authorization created",
      );
      return context.json(authorization);
    } catch (error) {
      if (
        error instanceof OAuthClientConfigError ||
        error instanceof OAuthFlowError ||
        error instanceof ConnectionError
      ) {
        this.options.logger?.warn(
          {
            errorCode: error.code,
            path: context.req.path,
            service: requestedService,
            connectionName,
          },
          "oauth authorization failed",
        );
        const status = error.code === "unknown_service" ? 404 : 400;
        return jsonError(context, status, error.code, error.message);
      }

      throw error;
    }
  }

  private async listRuntimeTokens(context: Context): Promise<Response> {
    return context.json(await this.options.runtimeTokens.listTokens());
  }

  private async createRuntimeToken(context: Context): Promise<Response> {
    const body = await readJsonBody(context, policyRequestMaxBytes);
    const name = optionalString(body.name);
    if (!name) {
      return jsonError(context, 400, "invalid_input", "name is required.");
    }

    const created = await this.options.runtimeTokens.createToken(name, readTokenPolicy(body, true));
    return context.json({
      token: created.token,
      record: summarizeRuntimeToken(created.record),
    });
  }

  private async updateRuntimeToken(context: Context, id: string): Promise<Response> {
    const body = await readJsonBody(context, policyRequestMaxBytes);
    const token = await this.options.runtimeTokens.updateTokenPolicy(id, readTokenPolicy(body));
    return token
      ? context.json(token)
      : jsonError(context, 404, "runtime_token_not_found", `Runtime token not found: ${id}.`);
  }

  private async revokeRuntimeToken(context: Context, id: string): Promise<Response> {
    if (!(await this.options.runtimeTokens.revokeToken(id))) {
      return jsonError(context, 404, "runtime_token_not_found", `Runtime token not found: ${id}.`);
    }

    return context.json({ id, revoked: true });
  }

  private async getIdentityProviderConfig(context: Context): Promise<Response> {
    const config = await this.options.accessGrants?.getIdentityProviderConfig();
    return context.json(config ?? null);
  }

  private async updateIdentityProviderConfig(context: Context): Promise<Response> {
    if (!this.options.accessGrants)
      return jsonError(context, 500, "access_grants_unavailable", "Access grants are unavailable.");
    const body = await readJsonBody(context, policyRequestMaxBytes);
    try {
      return context.json(
        await this.options.accessGrants.upsertIdentityProviderConfig(readIdentityProviderConfig(body)),
      );
    } catch (error) {
      return jsonError(
        context,
        400,
        "invalid_input",
        error instanceof Error ? error.message : "Invalid identity provider config.",
      );
    }
  }

  private async listAccessGrants(context: Context): Promise<Response> {
    if (!this.options.accessGrants) return this.writeAccessUnavailable(context);
    const grants = await this.options.accessGrants.listGrants();
    return context.req.path.startsWith("/v1/") ? writeRuntimeSuccess(context, grants) : context.json(grants);
  }

  private async createAccessGrant(context: Context): Promise<Response> {
    if (!this.options.accessGrants) return this.writeAccessUnavailable(context);
    const body = await readJsonBody(context, policyRequestMaxBytes);
    try {
      const grant = await this.options.accessGrants.createGrant(readAccessGrantInput(body));
      return context.req.path.startsWith("/v1/") ? writeRuntimeSuccess(context, grant) : context.json(grant);
    } catch (error) {
      return this.writeAccessInputError(context, error);
    }
  }

  private async updateAccessGrant(context: Context, id: string): Promise<Response> {
    if (!this.options.accessGrants) return this.writeAccessUnavailable(context);
    const body = await readJsonBody(context, policyRequestMaxBytes);
    try {
      const grant = await this.options.accessGrants.updateGrant(id, readPartialAccessGrantInput(body));
      if (!grant) return this.writeAccessNotFound(context, id);
      return context.req.path.startsWith("/v1/") ? writeRuntimeSuccess(context, grant) : context.json(grant);
    } catch (error) {
      return this.writeAccessInputError(context, error);
    }
  }

  private async revokeAccessGrant(context: Context, id: string): Promise<Response> {
    if (!this.options.accessGrants) return this.writeAccessUnavailable(context);
    const grant = await this.options.accessGrants.revokeGrant(id);
    if (!grant) return this.writeAccessNotFound(context, id);
    return context.req.path.startsWith("/v1/") ? writeRuntimeSuccess(context, grant) : context.json(grant);
  }

  private async previewAccess(context: Context): Promise<Response> {
    if (!this.options.accessGrants) return this.writeAccessUnavailable(context);
    const body = await readJsonBody(context, policyRequestMaxBytes);
    const subject = readRuntimeSubject(context) ?? readPreviewSubject(body);
    if (!subject) {
      return this.writeAccessInputError(context, new Error("A verified JWT subject or preview subject is required."));
    }
    const connectionId = optionalString(body.connectionId);
    const actionId = optionalString(body.actionId);
    const snapshot = await this.options.accessGrants.createSnapshot(subject);
    const action = actionId ? this.options.catalog.actionsById.get(actionId) : undefined;
    if (actionId && !action) {
      return context.req.path.startsWith("/v1/")
        ? writeRuntimeFailure(context, unknownActionFailure(actionId))
        : jsonError(context, 404, "unknown_action", `Unknown action: ${actionId}`);
    }
    const decision = action ? snapshot.evaluateAction(action, connectionId) : snapshot.evaluateConnection(connectionId);
    const payload = { subject, connectionId, actionId, decision, policyVersion: snapshot.version };
    return context.req.path.startsWith("/v1/") ? writeRuntimeSuccess(context, payload) : context.json(payload);
  }

  private async listAccessAudit(context: Context): Promise<Response> {
    if (!this.options.accessGrants) return this.writeAccessUnavailable(context);
    const limit = Number(context.req.query("limit") ?? 200);
    const audit = await this.options.accessGrants.listAudit({ limit: Number.isFinite(limit) ? limit : 200 });
    return context.req.path.startsWith("/v1/") ? writeRuntimeSuccess(context, audit) : context.json(audit);
  }

  private async listIdentitySubjects(context: Context): Promise<Response> {
    if (!this.options.accessGrants) return this.writeAccessUnavailable(context);
    const subjects = await this.options.accessGrants.listSubjects();
    return context.req.path.startsWith("/v1/") ? writeRuntimeSuccess(context, subjects) : context.json(subjects);
  }

  private async getRuntimePolicy(context: Context): Promise<Response> {
    return context.json((await this.getPolicySnapshot(context)).state);
  }

  private async updateRuntimePolicy(context: Context): Promise<Response> {
    const body = await readJsonBody(context, policyRequestMaxBytes);
    const rules = readRuntimePolicyRules(body);
    const updatedAt = new Date().toISOString();
    await this.options.runtimePolicyStore.set({ rules, updatedAt });
    return context.json({
      deployment: this.actionPolicy.rules,
      runtime: rules,
      updatedAt,
    });
  }

  private async listOAuthConfigs(context: Context): Promise<Response> {
    return context.json(await this.options.oauthClientConfigs.listConfigs());
  }

  private async upsertOAuthConfig(context: Context, service: string): Promise<Response> {
    const body = await readJsonBody(context);
    return this.writeOAuthResult(
      context,
      this.options.oauthClientConfigs.upsertConfig({
        service,
        clientId: optionalString(body.clientId) ?? "",
        clientSecret: optionalString(body.clientSecret) ?? "",
        requestedScopes: readRequestedScopes(body),
        extra: optionalRecord(body.extra),
        secretExtra: optionalRecord(body.secretExtra),
      }),
    );
  }

  private async deleteOAuthConfig(context: Context, service: string): Promise<Response> {
    return this.writeOAuthResult(context, this.options.oauthClientConfigs.deleteConfig(service));
  }

  private async completeOAuth(context: Context): Promise<Response> {
    const state = context.req.query("state");
    const code = context.req.query("code");
    const logContext = {
      path: context.req.path,
      hasState: Boolean(state),
      hasCode: Boolean(code),
    };
    this.options.logger?.info(logContext, "oauth callback received");
    const providerError = context.req.query("error");
    if (providerError) {
      const providerErrorDescription = context.req.query("error_description");
      this.options.logger?.warn(
        {
          ...logContext,
          errorCode: "oauth_provider_error",
          providerError,
          providerErrorDescription,
        },
        "oauth callback failed",
      );
      return jsonError(
        context,
        400,
        "oauth_provider_error",
        `OAuth provider returned error "${providerError}"${providerErrorDescription ? `: ${providerErrorDescription}` : "."}`,
      );
    }
    if (!state || !code) {
      this.options.logger?.warn(
        {
          ...logContext,
          errorCode: "invalid_oauth_callback",
        },
        "oauth callback failed",
      );
      return jsonError(context, 400, "invalid_oauth_callback", "OAuth callback requires state and code.");
    }

    let service: string;
    try {
      service = (
        await this.options.oauthFlow.completeAuthorization({
          state,
          code,
          callbackParameters: Object.fromEntries(new URL(context.req.url).searchParams),
          signal: context.req.raw.signal,
        })
      ).service;
      this.options.logger?.info(
        {
          ...logContext,
          service,
        },
        "oauth callback completed",
      );
    } catch (error) {
      if (error instanceof OAuthFlowError || error instanceof ConnectionError) {
        const cancelled = error instanceof ConnectionError && error.code === "connection_cancelled";
        this.options.logger?.[cancelled ? "info" : "warn"](
          {
            ...logContext,
            errorCode: error.code,
          },
          cancelled ? "oauth callback cancelled" : "oauth callback failed",
        );
        return jsonError(context, error.code === "unknown_service" ? 404 : 400, error.code, error.message);
      }
      throw error;
    }

    return context.html(renderOAuthCompletionPage(service));
  }

  private async writeConnectionResult(
    context: Context,
    operation: Promise<unknown>,
    logContext?: ConnectionLogContext,
  ): Promise<Response> {
    try {
      const result = await operation;
      if (logContext) {
        this.options.logger?.info(
          logContext,
          logContext.operation === "disconnect" ? "connection disconnect completed" : "connection completed",
        );
      }
      return context.json(result);
    } catch (error) {
      if (error instanceof ConnectionError) {
        if (logContext) {
          const cancelled = error.code === "connection_cancelled";
          this.options.logger?.[cancelled ? "info" : "warn"](
            {
              ...logContext,
              errorCode: error.code,
            },
            cancelled
              ? "connection cancelled"
              : logContext.operation === "disconnect"
                ? "connection disconnect failed"
                : "connection failed",
          );
        }
        return jsonError(context, error.code === "unknown_service" ? 404 : 400, error.code, error.message);
      }

      throw error;
    }
  }

  private async writeOAuthResult(context: Context, operation: Promise<unknown>): Promise<Response> {
    try {
      return context.json(await operation);
    } catch (error) {
      if (error instanceof OAuthClientConfigError || error instanceof OAuthFlowError) {
        return jsonError(context, error.code === "unknown_service" ? 404 : 400, error.code, error.message);
      }
      if (error instanceof HttpRequestError) {
        return jsonError(context, 400, error.code, error.message);
      }

      throw error;
    }
  }

  private getPolicySnapshot(context: Context): Promise<ActionPolicySnapshot> {
    const request = context.req.raw;
    let snapshot = this.policySnapshots.get(request);
    if (!snapshot) {
      snapshot = this.loadPolicySnapshot(context);
      this.policySnapshots.set(request, snapshot);
    }
    return snapshot;
  }

  private async loadPolicySnapshot(context: Context): Promise<ActionPolicySnapshot> {
    try {
      const record = await this.options.runtimePolicyStore.get();
      const subject = readRuntimeSubject(context);
      const access =
        subject && this.options.accessGrants ? await this.options.accessGrants.createSnapshot(subject) : undefined;
      return this.actionPolicy.createSnapshot(
        record?.rules ?? emptyPolicyRules(),
        readRuntimeGrant(context),
        record?.updatedAt,
        access,
      );
    } catch {
      this.options.logger?.error(
        {
          method: context.req.method,
          path: context.req.path,
        },
        "runtime policy load failed",
      );
      throw new Error("Runtime policy is unavailable.");
    }
  }

  private async resolveRuntimeConnectionForPolicy(
    context: Context,
    service: string,
    connectionName: string | undefined,
    actionId: string,
  ): Promise<ConnectionSummary | undefined | Response> {
    if (!readRuntimeSubject(context)) return undefined;
    try {
      return await this.options.connections.getConnectionSummary(service, connectionName);
    } catch (error) {
      if (error instanceof ConnectionError) {
        return writeRuntimeFailure(context, {
          status: mapConnectionErrorStatus(error),
          errorCode: error.code,
          message: error.message,
          meta: { actionId },
        });
      }
      throw error;
    }
  }

  private writeAccessUnavailable(context: Context): Response {
    return context.req.path.startsWith("/v1/")
      ? writeRuntimeFailure(context, {
          status: 501,
          errorCode: "access_grants_unavailable",
          message: "Access grants are unavailable.",
        })
      : jsonError(context, 500, "access_grants_unavailable", "Access grants are unavailable.");
  }

  private writeAccessNotFound(context: Context, id: string): Response {
    return context.req.path.startsWith("/v1/")
      ? writeRuntimeFailure(context, {
          status: 404,
          errorCode: "access_grant_not_found",
          message: `Access grant not found: ${id}.`,
        })
      : jsonError(context, 404, "access_grant_not_found", `Access grant not found: ${id}.`);
  }

  private writeAccessInputError(context: Context, error: unknown): Response {
    const message = error instanceof Error ? error.message : "Invalid access grant input.";
    return context.req.path.startsWith("/v1/")
      ? writeRuntimeFailure(context, { status: 400, errorCode: "invalid_input", message })
      : jsonError(context, 400, "invalid_input", message);
  }
}

function readOAuthClientConfigInput(body: Record<string, unknown>): OAuthClientConfigInput | undefined {
  const keys = ["clientId", "clientSecret", "requestedScopes", "extra", "secretExtra"];
  if (!keys.some((key) => key in body)) {
    return undefined;
  }

  return {
    clientId: optionalString(body.clientId) ?? "",
    clientSecret: optionalString(body.clientSecret) ?? "",
    requestedScopes: readRequestedScopes(body),
    extra: optionalRecord(body.extra),
    secretExtra: optionalRecord(body.secretExtra),
  };
}

function readIdentityProviderConfig(body: Record<string, unknown>): IdentityProviderConfig {
  return {
    issuer: requiredString(body.issuer, "issuer", (message) => new HttpRequestError("invalid_input", `${message}.`)),
    audience: requiredString(
      body.audience,
      "audience",
      (message) => new HttpRequestError("invalid_input", `${message}.`),
    ),
    jwksUri: requiredString(
      body.jwksUri ?? body.jwks_uri,
      "jwksUri",
      (message) => new HttpRequestError("invalid_input", `${message}.`),
    ),
    userPoolRef: requiredString(
      body.userPoolRef ?? body.user_pool_ref,
      "userPoolRef",
      (message) => new HttpRequestError("invalid_input", `${message}.`),
    ),
    subjectClaim: optionalString(body.subjectClaim ?? body.subject_claim) ?? "sub",
    groupsClaim:
      optionalString(body.groupsClaim ?? body.groupClaim ?? body.groups_claim ?? body.group_claim) ?? "groups",
    tenantClaim: optionalString(body.tenantClaim ?? body.tenant_claim),
    tenant: optionalString(body.tenant),
  };
}

function readAccessGrantInput(body: Record<string, unknown>): AccessGrantInput {
  return {
    subjectType: readAccessSubjectType(body.subjectType ?? body.subject_type),
    subject: requiredString(body.subject, "subject", (message) => new HttpRequestError("invalid_input", `${message}.`)),
    connectionId: requiredString(
      body.connectionId ?? body.connection_id,
      "connectionId",
      (message) => new HttpRequestError("invalid_input", `${message}.`),
    ),
    role: readAccessRole(body.role),
    effect: readAccessEffect(body.effect),
    customActions: readOptionalStringList(body.customActions ?? body.custom_actions),
    reason: optionalString(body.reason),
  };
}

function readPartialAccessGrantInput(body: Record<string, unknown>): Partial<AccessGrantInput> {
  return {
    ...(body.role === undefined ? {} : { role: readAccessRole(body.role) }),
    ...(body.effect === undefined ? {} : { effect: readAccessEffect(body.effect) }),
    ...(body.customActions === undefined && body.custom_actions === undefined
      ? {}
      : { customActions: readOptionalStringList(body.customActions ?? body.custom_actions) }),
    ...(body.reason === undefined ? {} : { reason: optionalString(body.reason) ?? "" }),
  };
}

function readColonActionAccessGrantId(context: Context): string {
  const params = context.req.param() as Record<string, string | undefined>;
  const raw = params["id\\:revoke"] ?? params["id:revoke"] ?? params.id;
  if (!raw?.endsWith(":revoke")) {
    throw new HttpRequestError("invalid_input", "AccessGrant revoke id is required.");
  }
  return raw.slice(0, -":revoke".length);
}

function readPreviewSubject(body: Record<string, unknown>): ReturnType<typeof readRuntimeSubject> {
  const value = body.subject;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const sub = optionalString(record.sub);
  const issuer = optionalString(record.issuer);
  const audience = optionalString(record.audience);
  const userPoolRef = optionalString(record.userPoolRef ?? record.user_pool_ref);
  if (!sub || !issuer || !audience || !userPoolRef) return undefined;
  return {
    sub,
    issuer,
    audience,
    userPoolRef,
    tenant: optionalString(record.tenant),
    groups: readOptionalStringList(record.groups),
  };
}

function readAccessSubjectType(value: unknown): AccessGrantInput["subjectType"] {
  if (value === "user" || value === "group") return value;
  throw new HttpRequestError("invalid_input", "subjectType must be user or group.");
}

function readAccessRole(value: unknown): AccessGrantInput["role"] {
  if (value === "reader" || value === "operator" || value === "custom") return value;
  throw new HttpRequestError("invalid_input", "role must be reader, operator, or custom.");
}

function readAccessEffect(value: unknown): AccessGrantInput["effect"] {
  if (value === undefined) return undefined;
  if (value === "allow" || value === "deny") return value;
  throw new HttpRequestError("invalid_input", "effect must be allow or deny.");
}

function readOptionalStringList(value: unknown): string[] {
  if (value === undefined) return [];
  return requiredStringArray(value, "customActions", (message) => new HttpRequestError("invalid_input", `${message}.`));
}

function readRequestedScopes(body: Record<string, unknown>): string[] | undefined {
  if (!("requestedScopes" in body)) {
    return undefined;
  }
  return requiredStringArray(
    body.requestedScopes,
    "requestedScopes",
    (message) => new HttpRequestError("invalid_input", `${message}.`),
  );
}

interface ConnectionLogContext {
  operation: "connect" | "disconnect";
  path: string;
  service: string;
  authType?: string;
  connectionName?: string;
}

/**
 * RFC 7232 `If-None-Match` check. Handles `*`, comma-separated lists, and the
 * weak-comparison prefix (`W/`) so a validator round-tripped through gzip (which
 * downgrades strong to weak) still matches.
 */
function requestMatchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }
  if (ifNoneMatch.trim() === "*") {
    return true;
  }
  const target = stripWeakPrefix(etag);
  return ifNoneMatch.split(",").some((candidate) => stripWeakPrefix(candidate.trim()) === target);
}

function stripWeakPrefix(etag: string): string {
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

function readConnectionName(context: Context, body?: Record<string, unknown>): string | undefined {
  return (
    optionalString(body?.connectionName) ??
    optionalString(body?.alias) ??
    optionalString(context.req.header("x-oomol-connector-alias")) ??
    optionalString(context.req.header("x-oo-connector-alias")) ??
    optionalString(context.req.query("connectionName")) ??
    optionalString(context.req.query("alias"))
  );
}

type SearchQuery =
  | {
      ok: true;
      q: string;
      service?: string;
      limit: number;
    }
  | {
      ok: false;
      message: string;
    };

type RunLogListQuery =
  | {
      ok: true;
      input: RunLogListInput;
    }
  | {
      ok: false;
      message: string;
    };

interface RuntimeActionSearchResult {
  id: string;
  service: string;
  name: string;
  description: string;
  authenticated: boolean;
  inputSchema: RuntimeActionDefinition["inputSchema"];
  outputSchema: RuntimeActionDefinition["outputSchema"];
}

function serializeActionSearchResult(
  result: ActionSearchResult,
  action: RuntimeActionDefinition,
  authenticated: boolean,
): RuntimeActionSearchResult {
  return {
    id: result.id,
    service: result.service,
    name: result.name,
    description: result.description,
    authenticated,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
  };
}

function readRunLogListInput(context: Context): RunLogListQuery {
  const rawLimit = optionalString(context.req.query("limit"));
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { ok: false, message: "limit must be an integer between 1 and 100." };
  }

  const cursor = optionalString(context.req.query("cursor"));
  if (cursor !== undefined) {
    try {
      decodeRunLogCursor(cursor);
    } catch {
      return { ok: false, message: "cursor is invalid." };
    }
  }

  const input: RunLogListInput = { limit };
  if (cursor !== undefined) {
    input.cursor = cursor;
  }
  const service = optionalString(context.req.query("service"));
  if (service !== undefined) {
    input.service = service;
  }
  const actionId = optionalString(context.req.query("actionId"));
  if (actionId !== undefined) {
    if (actionId.length > 256) {
      return { ok: false, message: "actionId must be at most 256 characters." };
    }
    input.actionId = actionId;
  }
  const caller = optionalString(context.req.query("caller"));
  if (caller !== undefined) {
    if (!isRunLogCaller(caller)) {
      return { ok: false, message: "caller must be one of http, mcp, or web." };
    }
    input.caller = caller;
  }
  const ok = optionalString(context.req.query("ok"));
  if (ok !== undefined) {
    if (ok !== "true" && ok !== "false") {
      return { ok: false, message: "ok must be true or false." };
    }
    input.ok = ok === "true";
  }

  return { ok: true, input };
}

function isRunLogCaller(value: string): value is RunLogCaller {
  return value === "http" || value === "mcp" || value === "web";
}

function readSearchQuery(context: Context, defaultLimit = DEFAULT_ACTION_SEARCH_LIMIT): SearchQuery {
  const q = optionalString(context.req.query("q") ?? context.req.query("query"));
  if (!q || q.length > 256) {
    return { ok: false, message: "q must be a non-empty string of at most 256 characters." };
  }

  const rawLimit = optionalString(context.req.query("limit"));
  if (!rawLimit) {
    return {
      ok: true,
      q,
      service: optionalString(context.req.query("service")),
      limit: defaultLimit,
    };
  }

  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { ok: false, message: "limit must be an integer between 1 and 50." };
  }

  return {
    ok: true,
    q,
    service: optionalString(context.req.query("service")),
    limit,
  };
}
