import type { CatalogStore } from "../catalog-store.ts";
import type { TransitFileWriter } from "../core/types.ts";
import type { ActionDefinition } from "../core/types.ts";
import type { IProviderLoader, ProviderResourceCandidate } from "../providers/provider-loader.ts";
import type { ITransitFileService } from "../server/files/transit-file-store.ts";
import type { StagedTransitFile } from "../server/files/transit-file-store.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { IRunLogStore, RunLog } from "../server/storage/runtime-store.ts";
import type { EnablementEntry } from "./catalog.ts";
import type { OracleConnectionConfig, OracleQueryDriver } from "./oracle-adapter.ts";
import type { OracleDriverOptions } from "./oracle-driver.ts";
import type { ResourceRef, TenantPrincipal } from "./types.ts";
import type { Context } from "hono";
import type { DatabaseSync } from "node:sqlite";

import { Hono } from "hono";
import { ConnectionError } from "../connection-service.ts";
import { readJsonBody, jsonError } from "../server/api/http-utils.ts";
import { verifyPrincipalToken } from "./auth.ts";
import { CatalogEnablement } from "./catalog.ts";
import { TenantFileAdapter } from "./file-adapter.ts";
import { ConnectionJobStore } from "./job-store.ts";
import { ConnectionLeaseService, LeaseError } from "./lease.ts";
import { ControlledMcpAdapter, TenantMcpDefinitionStore } from "./mcp-adapter.ts";
import { OracleDatabaseAdapter } from "./oracle-adapter.ts";
import { redactSecrets, safeConnectionProfile } from "./redaction.ts";
import { RestIdempotencyStore, RestOpenApiAdapter } from "./rest-adapter.ts";
import { createTenantRuntime } from "./service.ts";
import { TenantWebDiscoveryStore } from "./web-discovery.ts";

export interface ConnectionControlAppOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  controlDatabase: DatabaseSync;
  secretCodec: ISecretCodec;
  authSecret: string;
  publicOrigin: string;
  enablement: EnablementEntry[];
  transitFiles?: TransitFileWriter;
  fileStore?: ITransitFileService;
  stageFileUpload?: <T>(request: Request, consume: (file: StagedTransitFile) => Promise<T>) => Promise<T>;
  oracleDriverFactory?: (config: OracleConnectionConfig, credentials: OracleDriverOptions) => OracleQueryDriver;
}

export function createConnectionControlApp(options: ConnectionControlAppOptions): Hono {
  const app = new Hono();
  const catalog = new CatalogEnablement(options.catalog, options.enablement);
  const leases = new ConnectionLeaseService(options.controlDatabase);

  app.get("/health", (context) => context.json({ ok: true, service: "connection-service", version: "1.0.0" }));
  app.use("/v1/*", async (context, next) => {
    if (context.req.path === "/v1/health") {
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
  app.get("/v1/catalog", (context) => context.json({ items: catalog.list() }));
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
        const candidates = options.providerLoader.discoverResources
          ? await options.providerLoader.discoverResources(
              connection.service,
              { getCredential: execution.getCredential, signal: context.req.raw.signal },
              context.req.raw.signal,
            )
          : [];
        const resources = candidates.map((candidate) =>
          toResourceRef(candidate, {
            tenantId: connection.tenantId,
            workspaceId: connection.workspaceId,
            connectionId,
          }),
        );
        runtime.resources.replace(connectionId, connection.revision, resources);
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
        profile = await runtime.connectionService.connectWithoutAuth(service, { connectionName });
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
    try {
      const result = await runtime.oauthFlow.completeAuthorization({
        state: requiredString(body.state),
        code: requiredString(body.code),
        callbackParameters: recordOf(body.callbackParameters) as Record<string, string>,
        signal: context.req.raw.signal,
      });
      return context.json(result);
    } catch (error) {
      return connectionError(context, error);
    }
  });
  app.post("/v1/connections/:connectionId/lease", async (context) => {
    const body = await readJsonBody(context);
    const connectionId = context.req.param("connectionId");
    const runtime = tenantRuntime(options, principalOf(context));
    const connection = runtime.connections.visibleRecord(connectionId);
    if (!connection) {
      return jsonError(context, 404, "connection_not_found", "Connection is not visible to this tenant.");
    }
    const requestedActions = requiredStringArray(body.allowedActions);
    if (requestedActions.some(isOwnerControlledStorageAction) && !runtime.connections.ownerRecord(connectionId)) {
      return jsonError(
        context,
        403,
        "connection_forbidden",
        "Storage write, delete, and presign actions require the connection owner.",
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
    const revoked = leases.revoke(context.req.param("jti"), principalOf(context));
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
      const result = await runtime.actions.run({
        actionId,
        invocationId,
        input: body.input,
        caller: "http",
        invocationId,
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
    return context.json({ items: (await runtime.actions.listRuns()).items });
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
  app.post("/v1/web-discovery/sessions", async (context) => {
    const body = await readJsonBody(context);
    try {
      const session = await tenantWebDiscovery(options, principalOf(context)).start({
        origin: requiredString(body.origin),
      });
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
  app.post("/v1/web-discovery/sessions/:sessionId/confirm", async (context) => {
    const body = await readJsonBody(context);
    try {
      const definition = await tenantWebDiscovery(options, principalOf(context)).confirm(
        context.req.param("sessionId"),
        {
          candidateId: requiredString(body.candidateId),
          origin: requiredString(body.origin),
          operationId: requiredString(body.operationId),
          readOnly: body.readOnly === true,
        },
      );
      return context.json({ definition }, 201);
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
  );
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
  return /^(?:aws_s3|aliyun_oss)\.(?:put_object|delete_object|generate_presigned_url)$/u.test(actionId);
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
