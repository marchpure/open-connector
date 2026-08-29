import type { CatalogStore } from "../catalog-store.ts";
import type { TransitFileWriter } from "../core/types.ts";
import type { ActionDefinition } from "../core/types.ts";
import type { IProviderLoader, ProviderResourceCandidate } from "../providers/provider-loader.ts";
import type { ITransitFileService } from "../server/files/transit-file-store.ts";
import type { StagedTransitFile } from "../server/files/transit-file-store.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { IRunLogStore, RunLog } from "../server/storage/runtime-store.ts";
import type { AdapterResourceKind } from "./adapter-resource-store.ts";
import type { EnablementEntry } from "./catalog.ts";
import type { OracleConnectionConfig, OracleQueryDriver } from "./oracle-adapter.ts";
import type { OracleDriverOptions } from "./oracle-driver.ts";
import type { ResourceRef, TenantPrincipal } from "./types.ts";
import type { WebEgressPolicy } from "./service.ts";
import type { WebObservation } from "./web-discovery.ts";
import type { ResolvedCredential } from "../core/types.ts";
import type { Context } from "hono";
import type { DatabaseSync } from "node:sqlite";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { ConnectionError } from "../connection-service.ts";
import { readJsonBody, jsonError } from "../server/api/http-utils.ts";
import { renderOAuthCompletionPage, renderOAuthErrorPage } from "../server/api/oauth-completion-page.ts";
import { TenantAdapterResourceStore } from "./adapter-resource-store.ts";
import { verifyPrincipalToken } from "./auth.ts";
import { CatalogEnablement } from "./catalog.ts";
import { isAllowedDataPlatformLeaseAction, isDataPlatformService } from "./data-platform-policy.ts";
import { TenantFileAdapter } from "./file-adapter.ts";
import { ConnectionJobStore } from "./job-store.ts";
import { ConnectionLeaseService, LeaseError } from "./lease.ts";
import { ControlledMcpAdapter, TenantMcpDefinitionStore } from "./mcp-adapter.ts";
import { OracleDatabaseAdapter } from "./oracle-adapter.ts";
import { redactSecrets, safeConnectionProfile } from "./redaction.ts";
import { RestIdempotencyStore, RestOpenApiAdapter } from "./rest-adapter.ts";
import { RuntimeMcpSseSessions } from "./runtime-mcp-sse.ts";
import {
  assertLeaseRuntimeRequest,
  createLeaseRuntimeMcpServer,
  resolveLeaseRuntimeMcpContext,
} from "./runtime-mcp.ts";
import { createTenantRuntime } from "./service.ts";
import { TenantOAuthStateStore } from "./tenant-store.ts";
import { TenantWebActionStore, webCredentialFromInput, publicWebAction } from "./web-action-store.ts";
import { TenantWebDiscoveryStore } from "./web-discovery.ts";

export interface ConnectionControlAppOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  controlDatabase: DatabaseSync;
  secretCodec: ISecretCodec;
  authSecret: string;
  publicOrigin: string;
  webEgress?: WebEgressPolicy;
  enablement: EnablementEntry[];
  transitFiles?: TransitFileWriter;
  fileStore?: ITransitFileService;
  stageFileUpload?: <T>(request: Request, consume: (file: StagedTransitFile) => Promise<T>) => Promise<T>;
  oracleDriverFactory?: (config: OracleConnectionConfig, credentials: OracleDriverOptions) => OracleQueryDriver;
  captureWebDiscovery?: (input: {
    principal: TenantPrincipal;
    sessionId: string;
    workerToken: string;
    pageUrl: string;
    approvedOrigin: string;
    submitObservation: (observation: WebObservation) => Promise<void>;
    saveCredential: (credential: ResolvedCredential) => Promise<void>;
  }) => Promise<{ observationsSubmitted: number; crossOriginNavigationsBlocked: number }>;
}

export function createConnectionControlApp(options: ConnectionControlAppOptions): Hono {
  const app = new Hono();
  const discoveryWorkerTokens = new Map<string, string>();
  const catalog = new CatalogEnablement(options.catalog, options.enablement);
  const leases = new ConnectionLeaseService(options.controlDatabase);
  const runtimeMcpDependencies = {
    catalog: options.catalog,
    providerLoader: options.providerLoader,
    controlDatabase: options.controlDatabase,
    secretCodec: options.secretCodec,
    publicOrigin: options.publicOrigin,
    transitFiles: options.transitFiles,
    webEgress: options.webEgress,
  };
  const runtimeMcpSse = new RuntimeMcpSseSessions(runtimeMcpDependencies);

  app.get("/health", (context) => context.json({ ok: true, service: "connection-service", version: "1.0.0" }));
  app.get("/web-discovery", (context) => context.html(renderWebDiscoveryPage()));
  app.get("/oauth/callback", async (context) => {
    const state = context.req.query("state");
    const code = context.req.query("code");
    const providerError = context.req.query("error") || context.req.query("error_description");
    if (providerError) {
      if (state) {
        const consumed = await TenantOAuthStateStore.takeForCallback(
          options.controlDatabase,
          options.secretCodec,
          state,
        );
        if (consumed) {
          TenantOAuthStateStore.updateStatus(options.controlDatabase, state, "provider_error", consumed.principal);
        }
      }
      return context.html(renderOAuthErrorPage("provider"), 400);
    }
    if (!state || !code) {
      return context.html(renderOAuthErrorPage(), 400);
    }

    const consumed = await TenantOAuthStateStore.takeForCallback(options.controlDatabase, options.secretCodec, state);
    if (!consumed) {
      return context.html(renderOAuthErrorPage(), 400);
    }
    try {
      const runtime = tenantRuntime(options, consumed.principal);
      const result = await runtime.oauthFlow.completeAuthorization({
        state,
        code,
        pendingState: consumed.state,
        callbackParameters: Object.fromEntries(new URL(context.req.url).searchParams),
        signal: context.req.raw.signal,
      });
      TenantOAuthStateStore.updateStatus(options.controlDatabase, state, "connected", consumed.principal);
      return context.html(renderOAuthCompletionPage(result.service));
    } catch (error) {
      // Callback pages are intentionally generic. OAuth code, state, tokens,
      // client secrets, provider response bodies, and tenant claims must not
      // be reflected into a browser or an error response.
      TenantOAuthStateStore.updateStatus(
        options.controlDatabase,
        state,
        error instanceof Error && "code" in error && error.code === "invalid_oauth_state" ? "expired" : "error",
        consumed.principal,
      );
      return context.html(renderOAuthErrorPage(), 400);
    }
  });
  app.get("/oauth/status", (context) => {
    const state = context.req.query("state");
    const principal = verifyPrincipalToken(readBearer(context), options.authSecret);
    const status = state ? TenantOAuthStateStore.getStatus(options.controlDatabase, state, principal) : undefined;
    return status
      ? context.json({
          service: status.service,
          connectionName: status.connectionName,
          status: status.status,
        })
      : jsonError(
          context,
          principal ? 404 : 401,
          principal ? "oauth_status_not_found" : "unauthorized",
          principal ? "OAuth authorization status was not found." : "A valid control-plane bearer token is required.",
        );
  });
  app.use("/v1/*", async (context, next) => {
    if (context.req.path === "/v1/health" || context.req.path === "/v1/runtime/mcp/sse") {
      await next();
      return;
    }
    const principal = verifyPrincipalToken(readBearer(context), options.authSecret);
    if (!principal) {
      return jsonError(context, 401, "unauthorized", "A valid control-plane bearer token is required.");
    }
    context.set("principal" as never, principal);
    await next();
  });
  app.get("/v1/health", (context) => context.json({ ok: true }));
  app.get("/v1/runtime/mcp/sse", (context) => {
    try {
      const leaseContext = resolveRuntimeMcpLease(context, leases);
      return runtimeMcpSse.open(leaseContext, context.req.raw);
    } catch (error) {
      return leaseError(context, error);
    }
  });
  app.post("/v1/runtime/mcp/sse", async (context) => {
    let leaseContext;
    try {
      leaseContext = resolveRuntimeMcpLease(context, leases);
      assertLeaseRuntimeRequest(runtimeMcpDependencies, leaseContext);
      await auditRuntimeMcpRequest(context.req.raw, leaseContext, options);
    } catch (error) {
      return leaseError(context, error);
    }
    const sessionId = context.req.query("sessionId");
    if (sessionId) {
      try {
        return await runtimeMcpSse.receive(sessionId, leaseContext, context.req.raw);
      } catch (error) {
        return leaseError(context, error);
      }
    }
    const handler = createMcpHandler(
      () => createLeaseRuntimeMcpServer(runtimeMcpDependencies, leaseContext, context.req.raw.signal),
      { legacy: "stateless", responseMode: "json" },
    );
    try {
      return await handler.fetch(context.req.raw);
    } finally {
      await handler.close();
    }
  });
  app.get("/v1/catalog", (context) => context.json({ items: catalog.list() }));
  // These are Connection Service-owned adapters, not OpenConnector providers.
  // Keep them in a separate capability surface so the browser can present the
  // real control-plane entry points without inventing provider catalog rows.
  app.get("/v1/adapters/capabilities", (context) =>
    context.json({
      items: [
        {
          service: "oracle_database",
          displayName: "Oracle Database",
          tier: "beta",
          connectorDefinitionVersion: "1.0.0",
          category: "adapter",
          capabilities: ["validate", "discover"],
          endpoints: ["/v1/adapters/oracle/validate", "/v1/adapters/oracle/discover"],
          configSchema: {
            type: "object",
            required: ["host", "port"],
            properties: {
              host: { type: "string", title: "Host" },
              port: { type: "integer", title: "Port", default: 1521 },
              serviceName: { type: "string", title: "Service name" },
              sid: { type: "string", title: "SID" },
              allowedSchemas: { type: "array", items: { type: "string" }, title: "Allowed schemas" },
            },
          },
          authSchema: {
            type: "object",
            required: ["user", "password"],
            properties: {
              user: { type: "string", title: "Username" },
              password: { type: "string", title: "Password", format: "password" },
            },
          },
        },
        {
          service: "rest_openapi",
          displayName: "REST / OpenAPI",
          tier: "beta",
          connectorDefinitionVersion: "1.0.0",
          category: "adapter",
          capabilities: ["validate", "invoke"],
          endpoints: ["/v1/adapters/rest/validate", "/v1/adapters/rest/invoke"],
          configSchema: {
            type: "object",
            required: ["baseUrl", "spec"],
            properties: {
              baseUrl: { type: "string", title: "Base URL", format: "uri" },
              spec: { type: "object", title: "OpenAPI JSON" },
              confirmed: { type: "boolean", title: "Confirmed" },
            },
          },
          authSchema: {
            type: "object",
            properties: {
              type: { type: "string", title: "Auth type" },
              header: { type: "string", title: "API key header" },
              value: { type: "string", title: "API key", format: "password" },
              token: { type: "string", title: "Bearer token", format: "password" },
            },
          },
        },
        {
          service: "mcp",
          displayName: "MCP Server",
          tier: "beta",
          connectorDefinitionVersion: "1.0.0",
          category: "adapter",
          capabilities: ["discover", "register", "invoke"],
          endpoints: ["/v1/adapters/mcp/discover", "/v1/adapters/mcp/definitions"],
          configSchema: {
            type: "object",
            required: ["transport"],
            properties: {
              transport: { type: "string", title: "Transport" },
              endpoint: { type: "string", title: "Endpoint", format: "uri" },
              command: { type: "string", title: "Local command" },
              args: { type: "array", items: { type: "string" }, title: "Arguments" },
              allowedTools: { type: "array", items: { type: "string" }, title: "Allowed tools" },
              allowLocalhostDev: { type: "boolean", title: "Allow localhost development" },
              allowedLocalhostPorts: { type: "array", items: { type: "integer" }, title: "Allowed localhost ports" },
              allowPrivateNetwork: { type: "boolean", title: "Allow private network in dev" },
            },
          },
          authSchema: { type: "object", properties: {} },
        },
        {
          service: "files",
          displayName: "Files",
          tier: "beta",
          connectorDefinitionVersion: "1.0.0",
          category: "adapter",
          capabilities: ["upload", "preview", "list"],
          endpoints: ["/v1/files", "/v1/files/{fileId}/preview"],
          configSchema: {
            type: "object",
            properties: {
              filename: { type: "string", title: "File" },
            },
          },
          authSchema: { type: "object", properties: {} },
        },
      ],
    }),
  );
  app.get("/v1/adapter-resources", (context) => {
    const resources = new TenantAdapterResourceStore(
      options.controlDatabase,
      principalOf(context),
      options.secretCodec,
    );
    return context.json({ items: resources.list() });
  });
  app.post("/v1/adapter-resources", async (context) => {
    try {
      const body = await readJsonBody(context);
      const kind = requiredString(body.kind) as AdapterResourceKind;
      if (!["oracle_database", "rest_openapi", "mcp", "files"].includes(kind)) {
        return jsonError(context, 400, "invalid_resource_kind", "Unsupported adapter resource kind.");
      }
      const resources = new TenantAdapterResourceStore(
        options.controlDatabase,
        principalOf(context),
        options.secretCodec,
      );
      const resource = await resources.save({
        kind,
        displayName: requiredString(body.displayName),
        visibility: optionalVisibility(body.visibility) ?? "personal",
        sourceId: requiredString(body.sourceId),
        metadata: recordOf(body.metadata),
        definition: recordOf(body.definition),
      });
      return context.json({ resource }, 201);
    } catch (error) {
      return jsonError(
        context,
        400,
        "adapter_resource_error",
        error instanceof Error ? error.message : "Adapter resource could not be saved.",
      );
    }
  });
  app.get("/v1/adapter-resources/:resourceId", async (context) => {
    const resources = new TenantAdapterResourceStore(
      options.controlDatabase,
      principalOf(context),
      options.secretCodec,
    );
    const resource = await resources.get(context.req.param("resourceId"));
    return resource
      ? context.json({ resource: { ...resource, definition: undefined } })
      : jsonError(context, 404, "adapter_resource_not_found", "Adapter resource was not found.");
  });
  app.get("/v1/files", async (context) => {
    if (!options.fileStore) return context.json({ items: [] });
    const files = tenantFileAdapter(options, principalOf(context)).list();
    return context.json({ items: files });
  });
  app.post("/v1/files", async (context) => {
    if (!options.fileStore) return jsonError(context, 500, "files_not_configured", "File storage is not configured.");
    try {
      if (options.stageFileUpload) {
        const file = await options.stageFileUpload(context.req.raw, (staged) =>
          tenantFileAdapter(options, principalOf(context)).uploadFromPath(staged),
        );
        return context.json({ file }, 201);
      }
      const form = await context.req.raw.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return jsonError(context, 400, "invalid_input", "file is required.");
      return context.json({ file: await tenantFileAdapter(options, principalOf(context)).upload(file) }, 201);
    } catch (error) {
      return jsonError(context, 400, "file_rejected", error instanceof Error ? error.message : "File rejected.");
    }
  });
  app.get("/v1/files/:fileId", async (context) => {
    if (!options.fileStore) return jsonError(context, 500, "files_not_configured", "File storage is not configured.");
    try {
      const file = await tenantFileAdapter(options, principalOf(context)).read(context.req.param("fileId"));
      return new Response(file.stream(), { headers: { "content-type": file.type || "application/octet-stream" } });
    } catch (error) {
      return jsonError(context, 404, "file_not_found", error instanceof Error ? error.message : "File not found.");
    }
  });
  app.get("/v1/files/:fileId/preview", async (context) => {
    if (!options.fileStore) return jsonError(context, 500, "files_not_configured", "File storage is not configured.");
    try {
      const preview = await tenantFileAdapter(options, principalOf(context)).preview(context.req.param("fileId"));
      return context.json({ preview });
    } catch (error) {
      return jsonError(context, 404, "file_not_found", error instanceof Error ? error.message : "File not found.");
    }
  });
  app.delete("/v1/files/:fileId", async (context) => {
    if (!options.fileStore) return jsonError(context, 500, "files_not_configured", "File storage is not configured.");
    const deleted = await tenantFileAdapter(options, principalOf(context)).delete(context.req.param("fileId"));
    return deleted ? context.json({ deleted: true }) : jsonError(context, 404, "file_not_found", "File not found.");
  });
  app.get("/v1/connections", async (context) => {
    const runtime = tenantRuntime(options, principalOf(context));
    return context.json({ items: await runtime.records() });
  });
  app.patch("/v1/connections/:connectionId", async (context) => {
    const body = await readJsonBody(context);
    const runtime = tenantRuntime(options, principalOf(context));
    const connectionId = context.req.param("connectionId");
    if (runtime.connections.visibleRecord(connectionId) && !runtime.connections.ownerRecord(connectionId)) {
      return jsonError(context, 403, "connection_forbidden", "Only the connection owner may manage it.");
    }
    const connectionName = optionalString(body.connectionName);
    const visibility = optionalVisibility(body.visibility);
    if (!connectionName && !visibility) {
      return jsonError(context, 400, "invalid_input", "connectionName or visibility is required.");
    }
    const record = runtime.connections.updateRecord(connectionId, { connectionName, visibility });
    if (record && visibility) {
      leases.revokeForConnection(connectionId, principalOf(context));
    }
    return record
      ? context.json({ connection: record })
      : jsonError(context, 404, "connection_not_found", "Connection is not visible to this tenant.");
  });
  app.delete("/v1/connections/:connectionId", (context) => {
    const principal = principalOf(context);
    const runtime = tenantRuntime(options, principal);
    const connectionId = context.req.param("connectionId");
    if (runtime.connections.visibleRecord(connectionId) && !runtime.connections.ownerRecord(connectionId)) {
      return jsonError(context, 403, "connection_forbidden", "Only the connection owner may manage it.");
    }
    if (!runtime.connections.revokeRecord(connectionId)) {
      return jsonError(context, 404, "connection_not_found", "Connection is not visible to this tenant.");
    }
    leases.revokeForConnection(connectionId, principal);
    new TenantWebActionStore(options.controlDatabase, principal, options.secretCodec, options.webEgress).revokeConnection(
      connectionId,
    );
    return new Response(null, { status: 204 });
  });
  app.put("/v1/connections/:connectionId/acl", async (context) => {
    const body = await readJsonBody(context);
    const principal = principalOf(context);
    const runtime = tenantRuntime(options, principal);
    const connectionId = context.req.param("connectionId");
    if (runtime.connections.visibleRecord(connectionId) && !runtime.connections.ownerRecord(connectionId)) {
      return jsonError(context, 403, "connection_forbidden", "Only the connection owner may manage it.");
    }
    const subjects = stringArray(body.subjects);
    const acl = runtime.connections.replaceAcl(connectionId, subjects);
    if (!acl) {
      return jsonError(context, 404, "connection_not_found", "Connection is not visible to this tenant.");
    }
    leases.revokeForConnection(connectionId, principal);
    return context.json({ acl });
  });
  app.post("/v1/connections/:connectionId/validate", async (context) => {
    const runtime = tenantRuntime(options, principalOf(context));
    const connectionId = context.req.param("connectionId");
    const connection = runtime.connections.visibleRecord(connectionId);
    if (!connection) {
      return jsonError(context, 404, "connection_not_found", "Connection is not visible to this tenant.");
    }
    const jobs = tenantJobs(options, principalOf(context));
    const job = jobs.create(connectionId, "validate");
    jobs.start(job.id);
    runtime.connections.setStatus(connectionId, "validating");
    try {
      await runtime.connectionService.validateStoredConnection(
        connection.service,
        connection.connectionName,
        context.req.raw.signal,
      );
      jobs.succeed(job.id, { validated: true });
      runtime.connections.setStatus(connectionId, "ready");
    } catch (error) {
      jobs.fail(job.id, {
        code: error instanceof ConnectionError ? error.code : "validation_failed",
        message: error instanceof Error ? error.message : "Connection validation failed.",
      });
      runtime.connections.setStatus(connectionId, "error");
    }
    return context.json({ job: jobs.get(job.id) }, 202);
  });
  app.post("/v1/connections/:connectionId/discover", async (context) => {
    const runtime = tenantRuntime(options, principalOf(context));
    const connectionId = context.req.param("connectionId");
    const connection = runtime.connections.visibleRecord(connectionId);
    if (!connection) {
      return jsonError(context, 404, "connection_not_found", "Connection is not visible to this tenant.");
    }
    const leaseToken = context.req.header("x-connection-lease");
    const invocationId = context.req.header("x-connection-invocation-id");
    const audience = context.req.header("x-connection-audience");
    if (!leaseToken || !invocationId || !audience) {
      await recordControlPlaneFailure(runtime.runs, {
        service: connection.service,
        actionId: `${connection.service}.discover_resources`,
        connectionId,
        invocationId: invocationId ?? undefined,
        errorCode: "lease_required",
      });
      return jsonError(context, 401, "lease_required", "A discovery lease and its invocation headers are required.");
    }
    try {
      runtime.leases.verify(leaseToken, principalOf(context), {
        connectionId,
        connectionRevision: connection.revision,
        actionId: `${connection.service}.discover_resources`,
        invocationId,
        audience,
      });
    } catch (error) {
      await recordControlPlaneFailure(runtime.runs, {
        service: connection.service,
        actionId: `${connection.service}.discover_resources`,
        connectionId,
        invocationId,
        errorCode: error instanceof LeaseError ? error.code : "invalid_lease",
      });
      return leaseError(context, error);
    }
    const jobs = tenantJobs(options, principalOf(context));
    const job = jobs.create(connectionId, "discover");
    jobs.start(job.id);
    const provider = options.catalog.providers.find((entry) => entry.service === connection.service);
    if (!provider) {
      jobs.fail(job.id, { code: "provider_not_found", message: "Provider definition was not found." });
    } else {
      try {
        const execution = await runtime.connectionService.resolveForExecution(
          connection.service,
          connection.connectionName,
        );
        const currentConnection = runtime.connections.visibleRecord(connectionId);
        if (!currentConnection) {
          throw new ConnectionError(
            "connection_not_found",
            `${connection.service} connection changed while resources were being discovered. Retry discovery.`,
          );
        }
        runtime.leases.verify(leaseToken, principalOf(context), {
          connectionId,
          connectionRevision: currentConnection.revision,
          actionId: `${connection.service}.discover_resources`,
          invocationId,
          audience,
        });
        const candidates = options.providerLoader.discoverResources
          ? await options.providerLoader.discoverResources(
              connection.service,
              { getCredential: execution.getCredential, signal: context.req.raw.signal },
              context.req.raw.signal,
            )
          : [];
        const discoveredConnection = runtime.connections.visibleRecord(connectionId);
        if (!discoveredConnection || discoveredConnection.revision !== currentConnection.revision) {
          throw new ConnectionError(
            "connection_not_found",
            `${connection.service} connection changed while resources were being discovered. Retry discovery.`,
          );
        }
        const resources = candidates.map((candidate) =>
          toResourceRef(candidate, {
            tenantId: discoveredConnection.tenantId,
            workspaceId: discoveredConnection.workspaceId,
            connectionId,
          }),
        );
        runtime.resources.replace(connectionId, discoveredConnection.revision, resources);
        jobs.succeed(job.id, {
          service: provider.service,
          definitionVersion: connection.connectorDefinitionVersion,
          resources,
          actions: provider.actions.map(({ id, name, description, inputSchema, outputSchema, execution }) => ({
            id,
            name,
            description,
            inputSchema,
            outputSchema,
            executable: execution.locallyExecutable,
          })),
        });
      } catch (error) {
        const code = error instanceof ConnectionError ? error.code : "discovery_failed";
        jobs.fail(job.id, {
          code,
          message: error instanceof Error ? error.message : "Connection resource discovery failed.",
        });
        await recordControlPlaneFailure(runtime.runs, {
          service: connection.service,
          actionId: `${connection.service}.discover_resources`,
          connectionId,
          invocationId,
          errorCode: code,
        });
      }
    }
    return context.json({ job: jobs.get(job.id) }, 202);
  });
  app.get("/v1/jobs/:jobId", (context) => {
    const job = tenantJobs(options, principalOf(context)).get(context.req.param("jobId"));
    return job ? context.json({ job }) : jsonError(context, 404, "job_not_found", "Connection job was not found.");
  });
  app.post("/v1/connections", async (context) => {
    const body = await readJsonBody(context);
    const service = requiredString(body.service);
    const authType = requiredString(body.authType);
    const connectionName = optionalString(body.connectionName) ?? "default";
    const provider = options.catalog.providers.find((entry) => entry.service === service);
    if (!provider || !catalog.get(service)) {
      return jsonError(context, 404, "connector_not_enabled", "Connector is not enabled for this service.");
    }
    const runtime = tenantRuntime(options, principalOf(context));
    const existing = (await runtime.records()).find(
      (record) => record.service === service && record.connectionName === connectionName,
    );
    if (existing && existing.ownerId !== principalOf(context).ownerId) {
      return jsonError(context, 403, "connection_forbidden", "Only the connection owner may replace it.");
    }
    try {
      let profile;
      if (authType === "api_key") {
        profile = await runtime.connectionService.connectWithApiKey(service, {
          connectionName,
          values: recordOf(body.values),
        });
      } else if (authType === "custom_credential") {
        profile = await runtime.connectionService.connectWithCustomCredential(service, {
          connectionName,
          values: recordOf(body.values),
        });
      } else if (authType === "no_auth") {
        profile = await runtime.connectionService.connectAndPersistWithoutAuth(service, { connectionName });
      } else {
        return jsonError(context, 400, "unsupported_auth_type", "OAuth connections use the OAuth flow endpoint.");
      }
      if (existing) {
        leases.revokeForConnection(existing.id, principalOf(context));
      }
      return context.json({ connection: redactConnection(profile as unknown as Record<string, unknown>) }, 201);
    } catch (error) {
      return connectionError(context, error);
    }
  });
  app.post("/v1/oauth/configs", async (context) => {
    const body = await readJsonBody(context);
    const runtime = tenantRuntime(options, principalOf(context));
    try {
      const summary = await runtime.oauthClientConfigs.upsertConfig({
        service: requiredString(body.service),
        clientId: requiredString(body.clientId),
        clientSecret: typeof body.clientSecret === "string" ? body.clientSecret : "",
        requestedScopes: Array.isArray(body.requestedScopes) ? body.requestedScopes.map(String) : undefined,
        extra: recordOf(body.extra),
        secretExtra: recordOf(body.secretExtra),
      });
      return context.json({ config: redactSecrets(summary) });
    } catch (error) {
      return connectionError(context, error);
    }
  });
  app.post("/v1/oauth/authorizations", async (context) => {
    const body = await readJsonBody(context);
    const runtime = tenantRuntime(options, principalOf(context));
    try {
      const authorization = await runtime.oauthFlow.startAuthorization({
        service: requiredString(body.service),
        connectionName: optionalString(body.connectionName),
        actionIds: Array.isArray(body.actionIds) ? body.actionIds.map(String) : undefined,
      });
      return context.json(authorization);
    } catch (error) {
      return connectionError(context, error);
    }
  });
  app.post("/v1/oauth/complete", async (context) => {
    const body = await readJsonBody(context);
    const runtime = tenantRuntime(options, principalOf(context));
    let state: string | undefined;
    try {
      state = requiredString(body.state);
      const result = await runtime.oauthFlow.completeAuthorization({
        state,
        code: requiredString(body.code),
        callbackParameters: recordOf(body.callbackParameters) as Record<string, string>,
        signal: context.req.raw.signal,
      });
      TenantOAuthStateStore.updateStatus(options.controlDatabase, state, "connected", principalOf(context));
      return context.json(result);
    } catch (error) {
      if (state) {
        TenantOAuthStateStore.updateStatus(options.controlDatabase, state, "error", principalOf(context));
      }
      return connectionError(context, error);
    }
  });
  app.post("/v1/connections/:connectionId/lease", async (context) => {
    const body = await readJsonBody(context);
    const connectionId = context.req.param("connectionId");
    const runtime = tenantRuntime(options, principalOf(context));
    let connection = runtime.connections.visibleRecord(connectionId);
    if (!connection) {
      return jsonError(context, 404, "connection_not_found", "Connection is not visible to this tenant.");
    }
    const connectionService = connection.service;
    const requestedActions = requiredStringArray(body.allowedActions);
    const webActions = new TenantWebActionStore(
      options.controlDatabase,
      principalOf(context),
      options.secretCodec,
      options.webEgress,
    );
    if (connectionService === "web_api") {
      const allowed = new Set(webActions.actionIds(connectionId));
      if (requestedActions.some((actionId) => !allowed.has(actionId))) {
        return jsonError(
          context,
          403,
          "lease_action_forbidden",
          "Every leased Web Action must be persisted on the connection.",
        );
      }
      try {
        const issued = leases.issue(principalOf(context), {
          connectionIds: [connectionId],
          connectionRevisions: { [connectionId]: connection.revision },
          allowedActions: requestedActions,
          invocationId: requiredString(body.invocationId),
          audience: requiredString(body.audience),
          ttlSeconds: body.ttlSeconds === undefined ? undefined : Number(body.ttlSeconds),
        });
        return context.json({ token: issued.token, claims: issued.claims }, 201);
      } catch (error) {
        return leaseError(context, error);
      }
    }
    const provider = options.catalog.providers.find((entry) => entry.service === connectionService);
    const declaredActions = new Set([
      ...(provider?.actions.map((action) => action.id) ?? []),
      `${connectionService}.discover_resources`,
    ]);
    if (
      requestedActions.some(
        (actionId) => !actionId.startsWith(`${connectionService}.`) || !declaredActions.has(actionId),
      )
    ) {
      if (isErpService(connectionService)) {
        return jsonError(context, 400, "invalid_action", "Every leased action must belong to the selected connection.");
      }
      return jsonError(
        context,
        403,
        "lease_action_forbidden",
        "A connection lease may include only actions owned by that connection.",
      );
    }
    try {
      await runtime.connectionService.resolveForExecution(connection.service, connection.connectionName);
      connection = runtime.connections.visibleRecord(connectionId);
      if (!connection) {
        return jsonError(context, 404, "connection_not_found", "Connection is not visible to this tenant.");
      }
    } catch (error) {
      return connectionError(context, error);
    }
    if (requestedActions.some(isOwnerControlledStorageAction) && !runtime.connections.ownerRecord(connectionId)) {
      return jsonError(
        context,
        403,
        "connection_forbidden",
        "Storage write, delete, and presign actions require the connection owner.",
      );
    }
    const prohibitedAgentActions = requestedActions.filter(
      (actionId) => !isErpMutationAction(actionId) && !isAllowedReadOnlyLeaseAction(connectionService, actionId),
    );
    if (prohibitedAgentActions.length > 0) {
      return jsonError(
        context,
        403,
        "lease_action_forbidden",
        `These capabilities cannot be delegated to an Agent lease: ${prohibitedAgentActions.join(", ")}.`,
      );
    }
    if (
      isDataPlatformService(connection.service) &&
      requestedActions.some((actionId) => {
        const action = options.catalog.actionsById.get(actionId);
        return (
          !action ||
          action.service !== connection.service ||
          !action.execution.locallyExecutable ||
          !isAllowedDataPlatformLeaseAction(connection.service, actionId)
        );
      })
    ) {
      return jsonError(
        context,
        403,
        "lease_action_forbidden",
        "The requested action is not in this data connector's bounded read allowlist.",
      );
    }
    if (isErpService(connection.service)) {
      const providerActionIds = new Set(
        options.catalog.providers
          .find((provider) => provider.service === connection.service)
          ?.actions.map((action) => action.id) ?? [],
      );
      const unknownActions = requestedActions.filter(
        (actionId) => !providerActionIds.has(actionId) && actionId !== `${connection.service}.discover_resources`,
      );
      if (unknownActions.length > 0) {
        return jsonError(context, 400, "invalid_action", "Every leased action must belong to the selected connection.");
      }
    }
    if (requestedActions.some(isErpMutationAction)) {
      return jsonError(
        context,
        403,
        "action_not_allowed",
        "ERP mutation actions are disabled for Agent leases in this release.",
      );
    }
    try {
      const issued = leases.issue(principalOf(context), {
        connectionIds: [connectionId],
        connectionRevisions: { [connectionId]: connection.revision },
        allowedActions: requestedActions,
        invocationId: requiredString(body.invocationId),
        audience: requiredString(body.audience),
        ttlSeconds: body.ttlSeconds === undefined ? undefined : Number(body.ttlSeconds),
      });
      return context.json({ token: issued.token, claims: issued.claims }, 201);
    } catch (error) {
      return leaseError(context, error);
    }
  });
  app.post("/v1/leases/:jti/revoke", (context) => {
    const principal = principalOf(context);
    const jti = context.req.param("jti");
    const scope = leases.scope(jti, principal);
    const revoked = leases.revoke(jti, principal);
    if (revoked) {
      new TenantWebActionStore(options.controlDatabase, principal, options.secretCodec, options.webEgress).audit(
        "revoke",
        { jti, connectionIds: scope?.connectionIds, allowedActions: scope?.allowedActions },
        undefined,
        scope?.invocationId,
      );
    }
    return revoked
      ? context.json({ revoked: true })
      : jsonError(context, 404, "lease_not_found", "Lease was not found.");
  });
  app.post("/v1/runtime/actions/:actionId", async (context) => {
    const body = await readJsonBody(context);
    const runtime = tenantRuntime(options, principalOf(context));
    const invocationId = requiredString(body.invocationId);
    const audience = requiredString(body.audience);
    const actionId = context.req.param("actionId");
    const leaseToken = context.req.header("x-connection-lease");
    if (!leaseToken) {
      await recordControlPlaneFailure(runtime.runs, {
        service: "connection-control",
        actionId,
        connectionId: optionalString(body.connectionId),
        invocationId,
        errorCode: "lease_required",
      });
      return jsonError(context, 401, "lease_required", "X-Connection-Lease is required.");
    }
    const connectionIds = await Promise.all(
      (await runtime.records()).map((record) =>
        record.id === body.connectionId ? Promise.resolve(record) : Promise.resolve(undefined),
      ),
    );
    const selected = connectionIds.find(Boolean);
    if (!selected) {
      await recordControlPlaneFailure(runtime.runs, {
        service: "connection-control",
        actionId,
        connectionId: optionalString(body.connectionId),
        invocationId,
        errorCode: "connection_not_found",
      });
      return jsonError(context, 404, "connection_not_found", "Connection is not visible to this tenant.");
    }
    try {
      const claims = runtime.leases.verify(leaseToken, principalOf(context), {
        connectionId: selected.id,
        connectionRevision: selected.revision,
        actionId,
        invocationId,
        audience,
      });
      await runtime.connectionService.resolveForExecution(selected.service, selected.connectionName);
      const current = runtime.connections.visibleRecord(selected.id);
      if (!current) {
        throw new LeaseError("lease_scope_denied", "Connection lease does not grant this invocation.");
      }
      runtime.leases.verify(leaseToken, principalOf(context), {
        connectionId: current.id,
        connectionRevision: current.revision,
        actionId,
        invocationId,
        audience,
      });
      const result = await runtime.actions.run({
        actionId,
        invocationId,
        input: body.input,
        caller: "http",
        connectionName: selected.connectionName,
        policy: {
          evaluate: (action: ActionDefinition) =>
            claims.allowedActions.includes(action.id)
              ? { allowed: true, checks: [] }
              : {
                  allowed: false,
                  code: "action_not_allowed",
                  message: "Action is not granted by the connection lease.",
                  checks: [],
                },
          evaluateConnection: (connectionId: string | undefined) =>
            connectionId && claims.connectionIds.includes(connectionId)
              ? { allowed: true, checks: [] }
              : {
                  allowed: false,
                  code: "connection_not_allowed",
                  message: "Connection is not granted by the connection lease.",
                  checks: [],
                },
        } as never,
        signal: context.req.raw.signal,
      });
      if (result?.result.ok && options.providerLoader.observeActionResources) {
        try {
          const candidates = await options.providerLoader.observeActionResources(
            selected.service,
            actionId,
            result.result.output,
          );
          if (candidates.length > 0) {
            runtime.resources.appendIfCurrent(
              selected.id,
              current.revision,
              selected.service,
              candidates.slice(0, 100).map((candidate) =>
                toResourceRef(candidate, {
                  tenantId: current.tenantId,
                  workspaceId: current.workspaceId,
                  connectionId: current.id,
                }),
              ),
            );
          }
        } catch {
          // Resource observation is authorization enrichment. A parser or
          // persistence failure must not rewrite an already completed action.
        }
      }
      return context.json(
        {
          executionId: result?.executionId,
          auditPersisted: result?.auditPersisted,
          ok: result?.result.ok ?? false,
          result: redactSecrets(result?.result),
        },
        result?.result.ok ? 200 : 502,
      );
    } catch (error) {
      await recordControlPlaneFailure(runtime.runs, {
        service: selected.service,
        actionId,
        connectionId: selected.id,
        invocationId,
        errorCode: error instanceof LeaseError ? error.code : "invalid_lease",
      });
      return leaseError(context, error);
    }
  });
  app.get("/v1/audit", async (context) => {
    const runtime = tenantRuntime(options, principalOf(context));
    return context.json({
      items: (
        await runtime.actions.listRuns({
          invocationId: optionalString(context.req.query("invocationId")),
        })
      ).items,
    });
  });
  app.post("/v1/adapters/rest/invoke", async (context) => {
    const body = await readJsonBody(context);
    try {
      const principal = principalOf(context);
      let spec = body.spec && typeof body.spec === "object" ? (body.spec as Record<string, unknown>) : undefined;
      if (!spec && optionalString(body.specFileId)) {
        if (!options.fileStore) {
          return jsonError(context, 500, "files_not_configured", "File storage is not configured.");
        }
        const file = await tenantFileAdapter(options, principal).read(requiredString(body.specFileId));
        if (!file.name.toLowerCase().endsWith(".json")) {
          return jsonError(context, 400, "invalid_spec", "Uploaded OpenAPI specs must be JSON files.");
        }
        spec = JSON.parse(await file.text()) as Record<string, unknown>;
      }
      const adapter = RestOpenApiAdapter.fromSpec(
        requiredString(body.baseUrl),
        spec,
        parseRestAuth(body.auth),
        body.confirmed === true,
        undefined,
        new RestIdempotencyStore(
          options.controlDatabase,
          { tenantId: principal.tenantId, workspaceId: principal.workspaceId },
          options.secretCodec,
        ),
      );
      return context.json({
        result: redactSecrets(
          await adapter.invoke({
            operationId: requiredString(body.operationId),
            pathParams: recordOf(body.pathParams) as Record<string, string>,
            query: recordOf(body.query) as Record<string, string>,
            body: body.input,
            confirmed: body.confirmed === true,
            idempotencyKey: optionalString(body.idempotencyKey),
            pagination:
              body.pagination && typeof body.pagination === "object"
                ? { maxPages: Number(recordOf(body.pagination).maxPages) }
                : undefined,
          }),
        ),
      });
    } catch (error) {
      return jsonError(
        context,
        400,
        "rest_adapter_error",
        error instanceof Error ? error.message : "REST adapter failed.",
      );
    }
  });
  app.post("/v1/adapters/rest/validate", async (context) => {
    const body = await readJsonBody(context);
    try {
      const adapter = RestOpenApiAdapter.fromSpec(
        requiredString(body.baseUrl),
        body.spec && typeof body.spec === "object" ? (body.spec as Record<string, unknown>) : undefined,
        parseRestAuth(body.auth),
        body.confirmed === true,
      );
      return context.json({ result: adapter.describe() });
    } catch (error) {
      return jsonError(
        context,
        400,
        "rest_adapter_error",
        error instanceof Error ? error.message : "REST validation failed.",
      );
    }
  });
  app.post("/v1/web-discovery/sessions", async (context) => {
    const body = await readJsonBody(context);
    try {
      const session = await tenantWebDiscovery(options, principalOf(context)).start({
        origin: requiredString(body.origin),
      });
      discoveryWorkerTokens.set(session.id, session.workerToken);
      return context.json({ session }, 201);
    } catch (error) {
      return jsonError(
        context,
        400,
        "web_discovery_error",
        error instanceof Error ? error.message : "Discovery failed.",
      );
    }
  });
  app.post("/v1/web-discovery/sessions/:sessionId/observations", async (context) => {
    const body = await readJsonBody(context);
    try {
      const candidate = await tenantWebDiscovery(options, principalOf(context)).observe(
        context.req.param("sessionId"),
        requiredString(context.req.header("x-web-discovery-token")),
        {
          url: requiredString(body.url),
          method: requiredString(body.method),
          requestHeaders: recordOf(body.requestHeaders) as Record<string, string>,
          requestSample: body.requestSample,
          requestQuerySample: recordOf(body.requestQuerySample) as Record<string, string>,
          responseStatus: Number(body.responseStatus),
          responseContentType: requiredString(body.responseContentType),
          responseSample: body.responseSample,
          redirectUrl: optionalString(body.redirectUrl),
        },
      );
      return context.json({ candidate }, 201);
    } catch (error) {
      return jsonError(
        context,
        400,
        "web_discovery_error",
        error instanceof Error ? error.message : "Discovery failed.",
      );
    }
  });
  app.get("/v1/web-discovery/sessions/:sessionId/candidates", async (context) => {
    try {
      const items = await tenantWebDiscovery(options, principalOf(context)).listCandidates(
        context.req.param("sessionId"),
      );
      return context.json({ items });
    } catch (error) {
      return jsonError(context, 404, "web_discovery_not_found", error instanceof Error ? error.message : "Not found.");
    }
  });
  app.post("/v1/web-discovery/capture", async (context) => {
    if (!options.captureWebDiscovery) {
      return jsonError(context, 500, "web_discovery_worker_unavailable", "The discovery worker is not configured.");
    }
    try {
      const body = await readJsonBody(context);
      const pageUrl = requiredString(body.pageUrl);
      const approvedOrigin = requiredString(body.approvedOrigin);
      const sessionId = requiredString(body.sessionId);
      const workerToken = discoveryWorkerTokens.get(sessionId);
      if (!workerToken) {
        return jsonError(context, 404, "web_discovery_not_found", "Discovery session is not active.");
      }
      const result = await options.captureWebDiscovery({
        principal: principalOf(context),
        sessionId,
        workerToken,
        pageUrl,
        approvedOrigin,
        submitObservation: async (observation) => {
          await tenantWebDiscovery(options, principalOf(context)).observe(sessionId, workerToken, observation);
        },
        saveCredential: async (credential) => {
          await tenantWebDiscovery(options, principalOf(context)).saveCredential(sessionId, workerToken, credential);
        },
      });
      return context.json({ result });
    } catch (error) {
      return jsonError(
        context,
        400,
        "web_discovery_error",
        error instanceof Error ? error.message : "Discovery worker failed.",
      );
    }
  });
  app.post("/v1/web-discovery/sessions/:sessionId/confirm", async (context) => {
    const body = await readJsonBody(context);
    try {
      const discovery = tenantWebDiscovery(options, principalOf(context));
      const candidate = await discovery.getCandidate(context.req.param("sessionId"), requiredString(body.candidateId));
      if (!candidate) return jsonError(context, 404, "web_discovery_not_found", "Candidate was not found.");
      if (
        requiredString(body.origin) !== candidate.origin ||
        (body.readOnly === true) !== candidate.readOnly ||
        !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(requiredString(body.operationId))
      ) {
        return jsonError(context, 400, "web_discovery_error", "Confirmation does not match the candidate.");
      }
      const authentication = parseWebAuthentication(body.authentication);
      const sessionCredential =
        body.credential === undefined && authentication.type === "cookie"
          ? await discovery.getCredential(context.req.param("sessionId"))
          : undefined;
      const definition = await discovery.confirm(context.req.param("sessionId"), {
        candidateId: requiredString(body.candidateId),
        origin: requiredString(body.origin),
        operationId: requiredString(body.operationId),
        readOnly: body.readOnly === true,
      });
      const action = await new TenantWebActionStore(
        options.controlDatabase,
        principalOf(context),
        options.secretCodec,
        options.webEgress,
      ).confirm({
        candidate,
        operationId: requiredString(body.operationId),
        connectionName: optionalString(body.connectionName),
        authentication,
        credential:
          body.credential === undefined
            ? sessionCredential
            : webCredentialFromInput(authentication, body.credential),
        parameterSources: recordOf(body.parameterSources) as Record<string, "path" | "query" | "body">,
        pagination:
          body.pagination && typeof body.pagination === "object"
            ? {
                supported: recordOf(body.pagination).supported !== false,
                maxPages: Number(recordOf(body.pagination).maxPages ?? 10),
              }
            : undefined,
        rateLimit:
          body.rateLimit && typeof body.rateLimit === "object"
            ? { maxRequestsPerMinute: Number(recordOf(body.rateLimit).maxRequestsPerMinute ?? 60) }
            : undefined,
        timeoutMs: body.timeoutMs === undefined ? undefined : Number(body.timeoutMs),
        sideEffectConfirmed: body.sideEffectConfirmed === true,
        enabled: body.enabled === undefined ? undefined : body.enabled === true,
      });
      return context.json({ definition, action: publicWebAction(action) }, 201);
    } catch (error) {
      return jsonError(
        context,
        400,
        "web_discovery_error",
        error instanceof Error ? error.message : "Confirmation failed.",
      );
    }
  });
  app.post("/v1/adapters/mcp/discover", async (context) => {
    const body = await readJsonBody(context);
    try {
      return context.json(await new ControlledMcpAdapter(parseMcpDefinition(body.definition)).discover());
    } catch (error) {
      return jsonError(
        context,
        400,
        "mcp_adapter_error",
        error instanceof Error ? error.message : "MCP discovery failed.",
      );
    }
  });
  app.post("/v1/adapters/mcp/definitions", async (context) => {
    const body = await readJsonBody(context);
    try {
      const definition = parseMcpDefinition(body.definition);
      const stored = await tenantMcpDefinitions(options, principalOf(context)).save(definition);
      return context.json({ definition: stored }, 201);
    } catch (error) {
      return jsonError(
        context,
        400,
        "mcp_adapter_error",
        error instanceof Error ? error.message : "MCP definition failed.",
      );
    }
  });
  app.post("/v1/adapters/mcp/definitions/:definitionId/discover", async (context) => {
    try {
      const definition = await tenantMcpDefinitions(options, principalOf(context)).get(
        context.req.param("definitionId"),
      );
      if (!definition) return jsonError(context, 404, "mcp_definition_not_found", "MCP definition was not found.");
      return context.json(await new ControlledMcpAdapter(definition).discover());
    } catch (error) {
      return jsonError(
        context,
        400,
        "mcp_adapter_error",
        error instanceof Error ? error.message : "MCP discovery failed.",
      );
    }
  });
  app.post("/v1/adapters/mcp/definitions/:definitionId/call", async (context) => {
    const body = await readJsonBody(context);
    try {
      const definition = await tenantMcpDefinitions(options, principalOf(context)).get(
        context.req.param("definitionId"),
      );
      if (!definition) return jsonError(context, 404, "mcp_definition_not_found", "MCP definition was not found.");
      return context.json({
        result: redactSecrets(
          await new ControlledMcpAdapter(definition).callTool(requiredString(body.name), recordOf(body.arguments)),
        ),
      });
    } catch (error) {
      return jsonError(context, 400, "mcp_adapter_error", error instanceof Error ? error.message : "MCP call failed.");
    }
  });
  app.post("/v1/adapters/mcp/call", async (context) => {
    const body = await readJsonBody(context);
    try {
      return context.json({
        result: redactSecrets(
          await new ControlledMcpAdapter(parseMcpDefinition(body.definition)).callTool(
            requiredString(body.name),
            recordOf(body.arguments),
          ),
        ),
      });
    } catch (error) {
      return jsonError(context, 400, "mcp_adapter_error", error instanceof Error ? error.message : "MCP call failed.");
    }
  });
  app.post("/v1/adapters/oracle/query", async (context) => {
    const body = await readJsonBody(context);
    try {
      const adapter = oracleAdapter(options, body);
      return context.json({ result: await adapter.query(requiredString(body.sql), recordOf(body.binds)) });
    } catch (error) {
      return jsonError(
        context,
        400,
        "oracle_adapter_error",
        error instanceof Error ? error.message : "Oracle query failed.",
      );
    }
  });
  app.post("/v1/adapters/oracle/validate", async (context) => {
    const body = await readJsonBody(context);
    try {
      const adapter = oracleAdapter(options, body);
      return context.json({ result: await adapter.query("select 1 as ok from dual", {}) });
    } catch (error) {
      return jsonError(
        context,
        400,
        "oracle_adapter_error",
        error instanceof Error ? error.message : "Oracle validation failed.",
      );
    }
  });
  app.post("/v1/adapters/oracle/discover", async (context) => {
    const body = await readJsonBody(context);
    try {
      const adapter = oracleAdapter(options, body);
      return context.json({
        result: await adapter.discover({
          schema: optionalString(body.schema),
          table: optionalString(body.table),
        }),
      });
    } catch (error) {
      return jsonError(
        context,
        400,
        "oracle_adapter_error",
        error instanceof Error ? error.message : "Oracle discovery failed.",
      );
    }
  });
  return app;
}

function tenantRuntime(options: ConnectionControlAppOptions, principal: TenantPrincipal) {
  return createTenantRuntime(
    {
      catalog: options.catalog,
      providerLoader: options.providerLoader,
      controlDatabase: options.controlDatabase,
      secretCodec: options.secretCodec,
      publicOrigin: options.publicOrigin,
      transitFiles: options.transitFiles,
      webEgress: options.webEgress,
    },
    principal,
  );
}

function tenantFileAdapter(options: ConnectionControlAppOptions, principal: TenantPrincipal) {
  return new TenantFileAdapter(principal.tenantId, principal.workspaceId, options.fileStore!, options.controlDatabase);
}

function tenantMcpDefinitions(options: ConnectionControlAppOptions, principal: TenantPrincipal) {
  return new TenantMcpDefinitionStore(
    options.controlDatabase,
    { tenantId: principal.tenantId, workspaceId: principal.workspaceId },
    options.secretCodec,
  );
}

function tenantWebDiscovery(options: ConnectionControlAppOptions, principal: TenantPrincipal) {
  return new TenantWebDiscoveryStore(
    options.controlDatabase,
    {
      tenantId: principal.tenantId,
      workspaceId: principal.workspaceId,
      subject: principal.subject,
    },
    options.secretCodec,
    options.webEgress,
  );
}

async function auditRuntimeMcpRequest(
  request: Request,
  leaseContext: import("./runtime-mcp.ts").LeaseRuntimeMcpContext,
  options: ConnectionControlAppOptions,
): Promise<void> {
  const body = (await request.clone().json().catch(() => undefined)) as
    | { method?: unknown }
    | Array<{ method?: unknown }>
    | undefined;
  const messages = Array.isArray(body) ? body : body ? [body] : [];
  if (!messages.some((message) => message.method === "tools/list")) return;
  new TenantWebActionStore(
    options.controlDatabase,
    principalOfLease(leaseContext),
    options.secretCodec,
    options.webEgress,
  ).audit("tools_list", { connectionId: leaseContext.connectionId }, undefined, leaseContext.invocationId);
}

function principalOfLease(lease: import("./runtime-mcp.ts").LeaseRuntimeMcpContext): TenantPrincipal {
  return {
    tenantId: lease.principal.tenantId,
    workspaceId: lease.principal.workspaceId,
    subject: lease.principal.subject,
    ownerId: lease.principal.ownerId,
    audience: lease.principal.audience,
  };
}

function tenantJobs(options: ConnectionControlAppOptions, principal: TenantPrincipal) {
  return new ConnectionJobStore(options.controlDatabase, {
    tenantId: principal.tenantId,
    workspaceId: principal.workspaceId,
  });
}

function principalOf(context: Context): TenantPrincipal {
  return context.get("principal") as TenantPrincipal;
}

function resolveRuntimeMcpLease(context: Context, leases: ConnectionLeaseService) {
  return resolveLeaseRuntimeMcpContext(
    leases,
    context.req.header("x-connection-lease"),
    {
      connectionId: context.req.query("connectionId"),
      invocationId: context.req.query("invocationId"),
      audience: context.req.query("audience"),
    },
    {
      connectionId: context.req.header("x-connection-id"),
      invocationId: context.req.header("x-connection-invocation-id") ?? context.req.header("invocationId"),
      audience: context.req.header("x-connection-audience") ?? context.req.header("audience"),
    },
  );
}

function toResourceRef(
  candidate: ProviderResourceCandidate,
  scope: Pick<ResourceRef, "tenantId" | "workspaceId" | "connectionId">,
): ResourceRef {
  return {
    ...scope,
    sourceType: candidate.sourceType,
    resourceId: candidate.resourceId,
    resourceToken: candidate.resourceToken,
    version: candidate.version,
    etag: candidate.etag,
    title: candidate.title,
    mimeType: candidate.mimeType,
    schema: candidate.schema,
    owner: candidate.owner,
    aclSummary: candidate.aclSummary,
    url: candidate.url,
  };
}

function readBearer(context: Context): string | undefined {
  const value = context.req.header("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Required string field is missing.");
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isOwnerControlledStorageAction(actionId: string): boolean {
  return /^(?:aws_s3|aliyun_oss|volcengine_tos|tencent_cos|huawei_obs|minio|qiniu_kodo)\.(?:put_object|delete_object|generate_presigned_url)$/u.test(
    actionId,
  );
}

function isAllowedReadOnlyLeaseAction(service: string, actionId: string): boolean {
  if (actionId === `${service}.discover_resources`) return true;
  if (isDataPlatformService(service)) return isAllowedDataPlatformLeaseAction(service, actionId);
  if (isErpService(service)) {
    return ["validate_connection", "discover_capabilities", "list_entities"].includes(actionNameOf(actionId));
  }
  const actionName = actionNameOf(actionId);
  if (/^(?:wps_mcp)\.(?:list_tools|call_tool)$/u.test(actionId)) return false;
  return /^(?:get|list|search|read|fetch|find|lookup|query|describe|inspect|check|count|validate|discover|preview|download|ping|test|whoami|resolve|retrieve|view)(?:_|$)/u.test(
    actionName,
  );
}

function actionNameOf(actionId: string): string {
  const actionName = actionId.slice(actionId.indexOf(".") + 1);
  return actionName;
}

function isErpMutationAction(actionId: string): boolean {
  return /^(?:erpnext\.(?:list_documents|get_document|get_document_count|get_document_value|create_document|update_document|delete_document|set_document_value)|netsuite\.(?:run_suiteql|list_records|get_record|create_record|update_record))$/u.test(
    actionId,
  );
}

function isErpService(service: string): boolean {
  return /^(?:erpnext|netsuite|sap_s4hana|oracle_fusion_erp|dynamics_365_finance|dynamics_365_business_central|odoo|kingdee_cloud|yonyou_bip)$/u.test(
    service,
  );
}

function optionalVisibility(value: unknown): "personal" | "team" | undefined {
  if (value === undefined) return undefined;
  if (value === "personal" || value === "team") return value;
  throw new Error("visibility must be personal or team.");
}

function requiredStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("A non-empty string array is required.");
  }
  return value.map((item) => String(item).trim());
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("A string array is required.");
  }
  return value.map((item) => String(item).trim());
}

function parseRestAuth(value: unknown) {
  const auth = recordOf(value);
  const type = optionalString(auth.type) ?? "none";
  if (type === "api_key") {
    return { type: "api_key" as const, header: requiredString(auth.header), value: requiredString(auth.value) };
  }
  if (type === "bearer") return { type: "bearer" as const, token: requiredString(auth.token) };
  if (type === "oauth2") return { type: "oauth2" as const, accessToken: requiredString(auth.accessToken) };
  return { type: "none" as const };
}

function parseWebAuthentication(value: unknown): import("./web-action-store.ts").WebAuthProfile {
  const auth = recordOf(value);
  const type = optionalString(auth.type) ?? "none";
  if (type === "api_key") {
    return { type: "api_key", header: requiredString(auth.header) };
  }
  if (type === "bearer") return { type: "bearer" };
  if (type === "cookie") return { type: "cookie" };
  if (type !== "none") throw new Error("Web Action authentication must be none, api_key, bearer, or cookie.");
  return { type: "none" };
}

function parseMcpDefinition(value: unknown) {
  const definition = recordOf(value);
  return {
    transport: requiredString(definition.transport) as "streamable_http" | "sse" | "stdio",
    endpoint: optionalString(definition.endpoint),
    command: optionalString(definition.command),
    args: Array.isArray(definition.args) ? definition.args.map(String) : undefined,
    env: recordOf(definition.env) as Record<string, string>,
    headers: recordOf(definition.headers) as Record<string, string>,
    allowedCommands: Array.isArray(definition.allowedCommands) ? definition.allowedCommands.map(String) : undefined,
    allowedHeaderNames: Array.isArray(definition.allowedHeaderNames)
      ? definition.allowedHeaderNames.map(String)
      : undefined,
    allowedTools: Array.isArray(definition.allowedTools) ? definition.allowedTools.map(String) : undefined,
    allowLocalhostDev: definition.allowLocalhostDev === true,
    allowedLocalhostPorts: Array.isArray(definition.allowedLocalhostPorts)
      ? definition.allowedLocalhostPorts
          .map(Number)
          .filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
      : undefined,
    allowPrivateNetwork: definition.allowPrivateNetwork === true,
    timeoutMs: definition.timeoutMs === undefined ? undefined : Number(definition.timeoutMs),
  };
}

function parseOracleConfig(value: unknown) {
  const config = recordOf(value);
  return {
    host: requiredString(config.host),
    port: Number(config.port),
    serviceName: optionalString(config.serviceName),
    sid: optionalString(config.sid),
  };
}

function oracleAdapter(options: ConnectionControlAppOptions, body: Record<string, unknown>) {
  if (!options.oracleDriverFactory) {
    throw new Error("Oracle driver is not configured.");
  }
  const config = parseOracleConfig(body.config);
  const credentials = {
    user: requiredString(body.user),
    password: requiredString(body.password),
  };
  const allowedSchemas = Array.isArray(body.allowedSchemas)
    ? body.allowedSchemas.map((schema) => requiredString(schema))
    : undefined;
  return new OracleDatabaseAdapter(config, options.oracleDriverFactory(config, credentials), {
    maxRows: 1000,
    maxBytes: 10 * 1024 * 1024,
    timeoutMs: 30_000,
    maxConcurrent: 2,
    allowedSchemas,
  });
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function redactConnection(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    profile: safeConnectionProfile(value.profile),
  };
}

function connectionError(context: Context, error: unknown) {
  if (error instanceof ConnectionError) {
    return jsonError(context, 400, error.code, error.message);
  }
  return jsonError(context, 400, "invalid_connection", error instanceof Error ? error.message : "Connection failed.");
}

function leaseError(context: Context, error: unknown) {
  if (error instanceof LeaseError) {
    const status = error.code === "lease_scope_denied" ? 401 : 400;
    return jsonError(context, status, error.code, error.message);
  }
  return jsonError(context, 400, "invalid_lease", error instanceof Error ? error.message : "Lease operation failed.");
}

async function recordControlPlaneFailure(
  runs: IRunLogStore,
  input: {
    service: string;
    actionId: string;
    connectionId?: string;
    invocationId?: string;
    errorCode: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const run: RunLog = {
    id: crypto.randomUUID(),
    service: input.service,
    actionId: input.actionId,
    caller: "http",
    invocationId: input.invocationId,
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    ok: false,
    connectionId: input.connectionId,
    errorCode: input.errorCode,
    errorMessage: "Connection control request failed.",
  };
  try {
    await runs.add(run);
  } catch {
    // Authorization failure must not be hidden by an audit-store outage.
  }
}

function renderWebDiscoveryPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Web Discovery</title>
<style>
:root{font:15px system-ui,sans-serif;color:#17202a;background:#f5f7fa}body{margin:0;padding:32px}main{max-width:920px;margin:auto;background:#fff;border:1px solid #d7dee8;padding:24px}h1{margin-top:0;font-size:24px}label{display:grid;gap:6px;margin:12px 0}input,button{box-sizing:border-box;min-height:38px;font:inherit}input{width:100%;border:1px solid #b9c4d0;padding:7px 10px}button{border:0;background:#1d4ed8;color:#fff;padding:0 14px;cursor:pointer}button.secondary{background:#475569}button:disabled{opacity:.55;cursor:wait}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.candidate{border-top:1px solid #e2e8f0;padding:14px 0}.candidate strong{display:block;margin-bottom:4px}pre{white-space:pre-wrap;background:#f8fafc;padding:10px;overflow:auto}.error{color:#b91c1c;min-height:22px}.success{color:#166534;min-height:22px}@media(max-width:700px){body{padding:12px}.grid{grid-template-columns:1fr}}
</style></head><body><main>
<h1>Web Discovery</h1><p>Discover same-origin JSON actions in an isolated browser, review the contract, then add it to a lease context.</p>
<div class="grid"><label>Control-plane bearer token<input id="auth" type="password" autocomplete="off"></label><label>HTTPS page URL<input id="url" type="url" placeholder="https://example.com/"></label></div>
<button id="discover" type="button">Discover</button><p id="status" class="success" role="status"></p><p id="error" class="error" role="alert"></p><section id="candidates"></section>
<section id="context" hidden><h2>Lease context</h2><pre id="contract"></pre><label>Invocation ID<input id="invocation" value="browser-web-discovery"></label><label>Audience<input id="audience" value="web-discovery-browser"></label><label>Authentication<select id="auth-type"><option value="none">None</option><option value="cookie">Cookie</option><option value="bearer">Bearer</option><option value="api_key">API key</option></select></label><label id="credential-field" hidden>Credential override<input id="credential" type="password" autocomplete="off"></label><label>Max pages<input id="max-pages" type="number" min="1" max="100" value="10"></label><label>Rate limit (requests/minute)<input id="rate-limit" type="number" min="1" value="60"></label><label>Timeout (milliseconds)<input id="timeout-ms" type="number" min="100" max="30000" value="30000"></label><label id="write-field" hidden><input id="write-confirm" type="checkbox"> Confirm side-effect and enable this write action</label><button id="add-context" type="button" class="secondary">Add confirmed action to context</button> <button id="call" type="button" disabled>Call action</button> <button id="call-error" type="button" disabled>Call rejected input</button><pre id="result"></pre></section>
</main><script>
const state={session:null,candidate:null,action:null,lease:null};const $=id=>document.getElementById(id);const showError=m=>{$("error").textContent=m||""};const showStatus=m=>{$("status").textContent=m||""};
async function api(path,init={}){const headers=new Headers(init.headers||{});headers.set("authorization","Bearer "+$("auth").value.trim());headers.set("content-type","application/json");const response=await fetch(path,{...init,headers});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.message||body.errorMessage||"Request failed ("+response.status+")");return body}
function parameterSources(item){return {path:(item.path.match(/\{[^}]+\}/g)||[]).map(name=>name.slice(1,-1)),query:Object.keys(item.querySchema?.properties||{}),body:Object.keys(item.requestSchema?.properties||{})}}
function renderCandidates(items){$("candidates").innerHTML=items.map((item,index)=>'<div class="candidate"><strong>'+item.method+" "+item.path+'</strong><pre>'+JSON.stringify({method:item.method,path:item.path,parameterSources:parameterSources(item),request:item.requestSchema,query:item.querySchema,response:item.responseSchema,readOnly:item.readOnly,sideEffect:item.readOnly?"none":"requires second confirmation",pagination:item.readOnly?"bounded pagination":"disabled by default",authentication:"explicit profile required",rateLimit:"bounded per minute",timeout:"bounded milliseconds",idempotency:item.readOnly?"not required":"Idempotency-Key required"},null,2)+'</pre><button type="button" data-candidate="'+index+'">Review this candidate</button></div>').join("");document.querySelectorAll("[data-candidate]").forEach(button=>button.addEventListener("click",()=>{state.candidate=items[Number(button.dataset.candidate)];$("context").hidden=false;$("contract").textContent=JSON.stringify({method:state.candidate.method,path:state.candidate.path,parameterSources:parameterSources(state.candidate),requestSchema:state.candidate.requestSchema,querySchema:state.candidate.querySchema,responseSchema:state.candidate.responseSchema,readOnly:state.candidate.readOnly,sideEffect:state.candidate.readOnly?"none":"second confirmation required",pagination:{supported:state.candidate.method==="GET",maxPages:Number($("max-pages").value)},rateLimit:{maxRequestsPerMinute:Number($("rate-limit").value)},timeoutMs:Number($("timeout-ms").value),idempotency:state.candidate.readOnly?"not required":"Idempotency-Key required"},null,2);$("write-field").hidden=state.candidate.readOnly;$("write-confirm").checked=false;$("call").disabled=true;$("call-error").disabled=true;showStatus("Candidate selected. Review the contract before confirming.")}))}
$("auth-type").addEventListener("change",()=>{$("credential-field").hidden=$("auth-type").value==="none"});
$("discover").addEventListener("click",async()=>{showError("");showStatus("Starting isolated discovery...");$("discover").disabled=true;try{const url=new URL($("url").value.trim());const started=await api("/v1/web-discovery/sessions",{method:"POST",body:JSON.stringify({origin:url.origin})});state.session=started.session;await api("/v1/web-discovery/capture",{method:"POST",body:JSON.stringify({sessionId:state.session.id,pageUrl:url.href,approvedOrigin:url.origin})});const candidates=await api("/v1/web-discovery/sessions/"+encodeURIComponent(state.session.id)+"/candidates");renderCandidates(candidates.items);showStatus("Discovery complete. Select a candidate to confirm it.")}catch(error){showError(error.message);showStatus("")}finally{$("discover").disabled=false}});
$("add-context").addEventListener("click",async()=>{showError("");showStatus("Confirming action and creating lease...");try{const authType=$("auth-type").value;const writeConfirmed=state.candidate.readOnly||$("write-confirm").checked;if(!writeConfirmed)throw new Error("Write actions require a second confirmation.");const confirmation={candidateId:state.candidate.id,origin:state.candidate.origin,operationId:"browser_"+state.candidate.method.toLowerCase()+"_action",readOnly:state.candidate.readOnly,authentication:{type:authType},parameterSources:parameterSources(state.candidate),pagination:{supported:state.candidate.method==="GET",maxPages:Number($("max-pages").value)},rateLimit:{maxRequestsPerMinute:Number($("rate-limit").value)},timeoutMs:Number($("timeout-ms").value),sideEffectConfirmed:writeConfirmed,enabled:state.candidate.readOnly||writeConfirmed};const credential=$("credential").value.trim();if(authType!=="none"&&credential)confirmation.credential={secret:credential};const confirmed=await api("/v1/web-discovery/sessions/"+encodeURIComponent(state.session.id)+"/confirm",{method:"POST",body:JSON.stringify(confirmation)});state.action=confirmed.action;const leased=await api("/v1/connections/"+encodeURIComponent(state.action.connectionId)+"/lease",{method:"POST",body:JSON.stringify({allowedActions:[state.action.id],invocationId:$("invocation").value.trim(),audience:$("audience").value.trim()})});state.lease=leased.token;$("call").disabled=false;$("call-error").disabled=false;showStatus("Action added to the lease context. It is ready for a runtime MCP call.")}catch(error){showError(error.message);showStatus("")}});
async function mcpCall(method,params,id){const url="/v1/runtime/mcp/sse?connectionId="+encodeURIComponent(state.action.connectionId)+"&invocationId="+encodeURIComponent($("invocation").value.trim())+"&audience="+encodeURIComponent($("audience").value.trim());const response=await fetch(url,{method:"POST",headers:{"x-connection-lease":state.lease,"content-type":"application/json","accept":"application/json, text/event-stream","MCP-Protocol-Version":"2025-06-18"},body:JSON.stringify({jsonrpc:"2.0",id,method,params})});const text=await response.text();const dataLines=text.split("\\n").filter(line=>line.startsWith("data: ")).map(line=>line.slice(6).trim()).filter(Boolean);const body=JSON.parse(dataLines.at(-1)||text||"{}");if(!response.ok||body.error)throw new Error(body.error?.message||body.message||"MCP request failed ("+response.status+")");return body.result}
$("call").addEventListener("click",async()=>{showError("");showStatus("Calling runtime MCP...");try{await mcpCall("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"web-discovery-browser",version:"1.0.0"}},1);const tools=await mcpCall("tools/list",{},2);const result=await mcpCall("tools/call",{name:"execute_action",arguments:{actionId:state.action.id,input:{}}},3);$("result").textContent=JSON.stringify({tools,result},null,2);showStatus("Runtime MCP returned.")}catch(error){$("result").textContent="";showError(error.message);showStatus("")}});
$("call-error").addEventListener("click",async()=>{showError("");showStatus("Calling runtime MCP with a rejected input...");try{const result=await mcpCall("tools/call",{name:"execute_action",arguments:{actionId:state.action.id,input:{password:"browser-error-probe"}}},4);$("result").textContent=JSON.stringify({errorState:result},null,2);if(result?.isError||result?.error||result?.content?.some(part=>part.text?.includes("web_credential_invalid")))showStatus("Runtime MCP returned the expected error state.");else showError("Expected sensitive input rejection was not returned.")}catch(error){$("result").textContent="";showError(error.message);showStatus("")}});
</script></body></html>`;
}
