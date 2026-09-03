import type { CatalogStore } from "../catalog-store.ts";
import type { ActionDefinition, ResolvedCredential, TransitFileWriter } from "../core/types.ts";
import type { CredentialBroker } from "../identity/credential-broker.ts";
import type { OAuthAccessTokenVerifier, VerifiedOAuthAccessToken } from "../identity/oauth-jwt-verifier.ts";
import type { TipVerifier } from "../identity/tip-types.ts";
import type { IProviderLoader, ProviderResourceCandidate } from "../providers/provider-loader.ts";
import type { ITransitFileService } from "../server/files/transit-file-store.ts";
import type { StagedTransitFile } from "../server/files/transit-file-store.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { IRunLogStore, RunLog } from "../server/storage/runtime-store.ts";
import type { AdapterResourceKind } from "./adapter-resource-store.ts";
import type { AppResourceRecord } from "./app-resource-store.ts";
import type {
  ApplicationCenterAuthConfig,
  ApplicationCenterRegistry,
  CredentialAuthConfig,
} from "./application-center-client.ts";
import type { EnablementEntry } from "./catalog.ts";
import type { CustomMcpVisibility } from "./custom-mcp-resource-store.ts";
import type { McpAuthorizer } from "./mcp-authorizer.ts";
import type { OracleConnectionConfig, OracleQueryDriver } from "./oracle-adapter.ts";
import type { OracleDriverOptions } from "./oracle-driver.ts";
import type { ConnectionRecord, ResourceRef, TenantPrincipal } from "./types.ts";
import type { Context } from "hono";
import type { DatabaseSync } from "node:sqlite";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { ConnectionError } from "../connection-service.ts";
import { CredentialAuthorizationRequiredError } from "../identity/credential-broker.ts";
import { mergeManagedCredential } from "../identity/managed-credential.ts";
import { readJsonBody, jsonError } from "../server/api/http-utils.ts";
import { renderOAuthCompletionPage, renderOAuthErrorPage } from "../server/api/oauth-completion-page.ts";
import { TenantAdapterResourceStore } from "./adapter-resource-store.ts";
import { AppResourceStore as TenantAppResourceStore } from "./app-resource-store.ts";
import { createArkClawMcpServer } from "./arkclaw-mcp.ts";
import { verifyPrincipalToken } from "./auth.ts";
import { CatalogEnablement } from "./catalog.ts";
import { proxyCustomMcp } from "./custom-mcp-proxy.ts";
import { CustomMcpResourceStore } from "./custom-mcp-resource-store.ts";
import { isAllowedDataPlatformLeaseAction, isDataPlatformService } from "./data-platform-policy.ts";
import { TenantFileAdapter } from "./file-adapter.ts";
import { ConnectionJobStore } from "./job-store.ts";
import { ConnectionLeaseService, LeaseError } from "./lease.ts";
import { ControlledMcpAdapter, TenantMcpDefinitionStore } from "./mcp-adapter.ts";
import { authorizeMcp } from "./mcp-authorizer.ts";
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
  arkclaw?: {
    apiKeyHashes: string[];
    verifyTip: TipVerifier;
    authorizer?: McpAuthorizer;
    credentialBroker?: CredentialBroker;
    verifyOAuthToken?: OAuthAccessTokenVerifier;
  };
  applicationCenter?: {
    registry: ApplicationCenterRegistry;
    spaceId: string;
    /** enterprise uses shared AiResource; user uses personal UserResource. */
    resourceMode?: "enterprise" | "user";
    clawId?: string;
    userPoolUserUid?: string;
    allowRawCredentialProvisioning?: boolean;
  };
  customMcp?: {
    allowPrivateNetwork?: boolean;
    proxyTimeoutMs?: number;
    fetcher?: typeof fetch;
    skipDnsValidation?: boolean;
  };
}

export function createConnectionControlApp(options: ConnectionControlAppOptions): Hono {
  const app = new Hono();
  const catalog = new CatalogEnablement(options.catalog, options.enablement);
  const leases = new ConnectionLeaseService(options.controlDatabase);
  const runtimeMcpDependencies = {
    catalog: options.catalog,
    providerLoader: options.providerLoader,
    controlDatabase: options.controlDatabase,
    secretCodec: options.secretCodec,
    publicOrigin: options.publicOrigin,
    transitFiles: options.transitFiles,
  };
  const runtimeMcpSse = new RuntimeMcpSseSessions(runtimeMcpDependencies);

  app.get("/health", (context) => context.json({ ok: true, service: "connection-service", version: "1.0.0" }));
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
  app.post("/v1/app-resources", async (context) => {
    const body = await readJsonBody(context);
    const principal = principalOf(context);
    const runtime = tenantRuntime(options, principal);
    const connectionId = requiredString(body.connectionId);
    const connection = runtime.connections.ownerRecord(connectionId);
    if (!connection)
      return jsonError(context, 404, "connection_not_found", "Connection is not visible to this tenant.");
    if (connection.service !== "oracle_database") {
      return jsonError(context, 400, "unsupported_resource", "Only Oracle Database resources are supported here.");
    }
    const actions = requiredStringArray(body.allowedActions);
    const invalidActions = actions.filter((actionId) => {
      const action = options.catalog.actionsById.get(actionId);
      return !action || action.service !== connection.service || !action.execution.locallyExecutable;
    });
    if (invalidActions.length > 0) {
      return jsonError(
        context,
        400,
        "invalid_action",
        "Every app resource action must belong to the Oracle connection.",
      );
    }
    try {
      const requestedCredentialRef = optionalString(body.credentialRef);
      if (requestedCredentialRef && requestedCredentialRef !== connection.credentialRef) {
        return jsonError(
          context,
          400,
          "credential_ref_mismatch",
          "App resources must use the credential reference bound to the connection.",
        );
      }
      if (connection.credentialMode === "local" && requestedCredentialRef) {
        return jsonError(
          context,
          400,
          "credential_ref_mismatch",
          "A local-credential connection cannot use a managed credential reference.",
        );
      }
      const resources = new TenantAppResourceStore(options.controlDatabase);
      const resourceId = optionalString(body.resourceId) ?? crypto.randomUUID();
      if (resources.hasResourceId(resourceId)) {
        return jsonError(context, 409, "app_resource_exists", "An app resource with this resourceId already exists.");
      }
      if (resources.getByName(requiredString(body.displayName), principal)) {
        return jsonError(context, 409, "app_resource_name_exists", "An app resource with this name already exists.");
      }
      const proxyCredentialAuthConfig = parseCredentialAuthConfig(body.credentialAuthConfig);
      const proxyCredential = parseProxyCredential(body.proxyCredential);
      if (proxyCredentialAuthConfig && proxyCredential) {
        return jsonError(
          context,
          400,
          "credential_config_conflict",
          "Use either proxyCredential or credentialAuthConfig, not both.",
        );
      }
      if (
        proxyCredentialAuthConfig &&
        options.applicationCenter &&
        !options.applicationCenter.allowRawCredentialProvisioning
      ) {
        return jsonError(
          context,
          403,
          "raw_credential_provisioning_disabled",
          "Raw CredentialAuthConfig provisioning is disabled; create a credential provider first and reference it.",
        );
      }
      const proxyAuthConfig = proxyCredential?.authConfig;
      const proxyApiKeyHashes =
        proxyCredentialAuthConfig?.Type === "api_key"
          ? proxyCredentialAuthConfig.ApikeyConfig!.map((config) => sha256(config.ApiKey))
          : [];
      const ingressAuth =
        optionalIngressAuth(body.ingressAuth) ??
        proxyCredential?.ingressAuth ??
        (proxyCredentialAuthConfig ? proxyCredentialAuthConfig.Type : undefined);
      if (body.ingressAuth !== undefined && proxyCredential && body.ingressAuth !== ingressAuth) {
        return jsonError(context, 400, "ingress_auth_mismatch", "ingressAuth must match proxyCredential type.");
      }
      const ingressApiKeyHashes = stringArrayOptional(body.ingressApiKeyHashes) ?? [];
      if (proxyCredential?.ingressAuth === "api_key" && ingressApiKeyHashes.length === 0) {
        return jsonError(
          context,
          400,
          "ingress_api_key_required",
          "API Key provider reference requires ingressApiKeyHashes for local ingress verification.",
        );
      }
      const applicationCenterMode = options.applicationCenter?.resourceMode ?? "enterprise";
      if (applicationCenterMode === "user" && !options.applicationCenter?.clawId) {
        return jsonError(context, 500, "application_center_config_error", "User resource mode requires a Claw ID.");
      }
      const applicationCenterInput = options.applicationCenter
        ? {
            spaceId: options.applicationCenter.spaceId,
            name: requiredString(body.displayName),
            description: optionalString(body.description),
            mcpUrl: new URL(`/mcp/apps/${encodeURIComponent(resourceId)}`, options.publicOrigin).toString(),
            ...(applicationCenterMode === "user" ? { clawId: options.applicationCenter.clawId } : {}),
            ...(applicationCenterMode === "user" &&
            (principal.userPoolUserUid ?? options.applicationCenter.userPoolUserUid)
              ? { userPoolUserUid: principal.userPoolUserUid ?? options.applicationCenter.userPoolUserUid }
              : {}),
            authConfig: proxyAuthConfig,
            credentialAuthConfig: proxyCredentialAuthConfig,
          }
        : undefined;
      const registered = applicationCenterInput
        ? await options.applicationCenter!.registry.createResource(applicationCenterInput, context.req.raw.signal)
        : undefined;
      let resource;
      try {
        resource = resources.save({
          resourceId,
          principal,
          displayName: requiredString(body.displayName),
          connectionId,
          allowedActions: actions,
          allowedResources: recordOf(body.allowedResources) as { schemas?: string[]; tables?: string[] },
          allowedSubjects: stringArrayOptional(body.allowedSubjects),
          allowedGroups: stringArrayOptional(body.allowedGroups),
          allowedAgentIds: stringArrayOptional(body.allowedAgentIds),
          credentialRef: connection.credentialMode === "managed" ? connection.credentialRef : undefined,
          ingressApiKeyHashes: [...ingressApiKeyHashes, ...proxyApiKeyHashes],
          requiredOAuthScopes: stringArrayOptional(body.requiredOAuthScopes),
          allowedOAuthClientIds: stringArrayOptional(body.allowedOAuthClientIds),
          oauthIdentityClaims: stringArrayOptional(body.oauthIdentityClaims),
          ingressAuth,
          visibility: optionalVisibility(body.visibility),
          mseResourceId: registered?.Id,
          mseGatewayUrl: registered?.NetworkConfig?.GatewayUrl,
          mseGatewayUrlType: registered?.NetworkConfig?.GatewayUrlType,
          mseStatus: registered?.Status,
          registrationStatus: applicationCenterInput ? "ready" : "local",
          credentialProviderNames: [
            ...credentialProviderNames(proxyCredentialAuthConfig),
            ...(proxyCredential?.providerNames ?? []),
          ],
        });
      } catch (error) {
        if (applicationCenterInput && registered?.Id) {
          try {
            await options.applicationCenter!.registry.deleteResource(
              registered.Id,
              applicationCenterInput,
              context.req.raw.signal,
            );
          } catch {
            // Preserve the persistence error; an operator can reconcile the external resource by ID.
          }
        }
        throw error;
      }
      return context.json({ resource: appResourceResponse(resource, options.publicOrigin) }, 201);
    } catch (error) {
      return jsonError(
        context,
        400,
        "app_resource_error",
        error instanceof Error ? error.message : "App resource could not be saved.",
      );
    }
  });
  app.get("/v1/custom-mcp-resources", (context) => {
    const resources = new CustomMcpResourceStore(options.controlDatabase);
    return context.json({
      items: resources
        .listForPrincipal(principalOf(context))
        .map((resource) => customMcpResourceResponse(resource, options.publicOrigin)),
    });
  });
  app.get("/v1/custom-mcp-resources/:resourceId", (context) => {
    const resources = new CustomMcpResourceStore(options.controlDatabase);
    const resource = resources.getForPrincipal(context.req.param("resourceId"), principalOf(context));
    return resource
      ? context.json({ resource: customMcpResourceResponse(resource, options.publicOrigin) })
      : jsonError(context, 404, "custom_mcp_not_found", "Custom MCP resource was not found.");
  });
  app.post("/v1/custom-mcp-resources", async (context) => {
    try {
      const body = await readJsonBody(context);
      const principal = principalOf(context);
      const resources = new CustomMcpResourceStore(options.controlDatabase);
      const resourceId = optionalString(body.resourceId) ?? crypto.randomUUID();
      const displayName = requiredString(body.displayName);
      if (resources.getByName(displayName, principal)) {
        return jsonError(
          context,
          409,
          "custom_mcp_name_exists",
          "A custom MCP resource with this name already exists.",
        );
      }
      const upstreamUrl = requiredString(body.upstreamUrl);
      assertCustomMcpUrl(upstreamUrl);
      const protocol = parseCustomMcpProtocol(body.protocol);
      const credential = parseCustomMcpCredential(body.proxyCredential);
      const ingressAuth = optionalIngressAuth(body.ingressAuth) ?? credential?.type ?? "api_key";
      if (credential && credential.type !== ingressAuth) {
        return jsonError(context, 400, "custom_mcp_auth_mismatch", "ingressAuth must match proxyCredential type.");
      }
      const ingressApiKeyHashes = stringArrayOptional(body.ingressApiKeyHashes) ?? [];
      if (ingressAuth === "api_key" && ingressApiKeyHashes.length === 0 && !credential) {
        return jsonError(
          context,
          400,
          "custom_mcp_api_key_required",
          "Direct API key ingress requires SHA-256 ingressApiKeyHashes or an Application Center provider reference.",
        );
      }
      const visibility = parseCustomMcpVisibility(body.visibility);
      const allowedSubjects = stringArrayOptional(body.allowedSubjects) ?? [];
      const allowedGroups = stringArrayOptional(body.allowedGroups) ?? [];
      const allowedAgentIds = stringArrayOptional(body.allowedAgentIds) ?? [];
      if (visibility === "partial" && allowedSubjects.length === 0 && allowedGroups.length === 0) {
        return jsonError(
          context,
          400,
          "custom_mcp_acl_required",
          "Partial visibility requires an authorized user or group.",
        );
      }
      const applicationCenterMode = options.applicationCenter?.resourceMode ?? "enterprise";
      if (applicationCenterMode === "user" && !options.applicationCenter?.clawId) {
        return jsonError(context, 500, "application_center_config_error", "User resource mode requires a Claw ID.");
      }
      const authorizedSubjects = [
        ...allowedSubjects.map((SubjectId) => ({ SubjectId, SubjectType: "USER" })),
        ...allowedGroups.map((SubjectId) => ({ SubjectId, SubjectType: "GROUP" })),
      ];
      if (visibility === "personal") authorizedSubjects.push({ SubjectId: principal.ownerId, SubjectType: "USER" });
      const mseVisibility = visibility === "team" && authorizedSubjects.length === 0 ? "Visible" : "PartiallyVisible";
      const applicationCenterInput = options.applicationCenter
        ? {
            spaceId: options.applicationCenter.spaceId,
            name: displayName,
            description: optionalString(body.description),
            mcpUrl: new URL(`/mcp/custom/${encodeURIComponent(resourceId)}`, options.publicOrigin).toString(),
            ...(applicationCenterMode === "user" ? { clawId: options.applicationCenter.clawId } : {}),
            ...(applicationCenterMode === "user" &&
            (principal.userPoolUserUid ?? options.applicationCenter.userPoolUserUid)
              ? { userPoolUserUid: principal.userPoolUserUid ?? options.applicationCenter.userPoolUserUid }
              : {}),
            ...(credential ? { authConfig: credential.authConfig } : {}),
            visibility: mseVisibility,
            ...(authorizedSubjects.length ? { authorizedSubjects } : {}),
          }
        : undefined;
      const registered = applicationCenterInput
        ? await options.applicationCenter!.registry.createResource(applicationCenterInput, context.req.raw.signal)
        : undefined;
      let resource;
      try {
        resource = resources.save({
          resourceId,
          principal,
          displayName,
          upstreamUrl,
          protocol,
          ...(credential
            ? { credentialProviderName: credential.providerName, credentialProviderType: credential.type }
            : {}),
          ingressAuth,
          ingressApiKeyHashes,
          requiredOAuthScopes: stringArrayOptional(body.requiredOAuthScopes),
          allowedOAuthClientIds: stringArrayOptional(body.allowedOAuthClientIds),
          oauthIdentityClaims: stringArrayOptional(body.oauthIdentityClaims),
          allowedSubjects,
          allowedGroups,
          allowedAgentIds,
          visibility,
          allowPrivateNetwork: body.allowPrivateNetwork === true,
          // An ingress bearer is not an upstream credential. Only an
          // Application Center provider reference may enable its forwarding.
          forwardAuthorization: Boolean(credential),
          forwardTipToken: body.forwardTipToken !== false,
          mseResourceId: registered?.Id,
          mseGatewayUrl: registered?.NetworkConfig?.GatewayUrl,
          mseGatewayUrlType: registered?.NetworkConfig?.GatewayUrlType,
          mseStatus: registered?.Status,
          registrationStatus: applicationCenterInput ? "ready" : "local",
        });
      } catch (error) {
        if (applicationCenterInput && registered?.Id) {
          await Promise.resolve(
            options.applicationCenter!.registry.deleteResource(
              registered.Id,
              applicationCenterInput,
              context.req.raw.signal,
            ),
          ).catch(() => undefined);
        }
        throw error;
      }
      return context.json({ resource: customMcpResourceResponse(resource, options.publicOrigin) }, 201);
    } catch (error) {
      return jsonError(
        context,
        400,
        "custom_mcp_resource_error",
        error instanceof Error ? error.message : "Custom MCP resource could not be created.",
      );
    }
  });
  app.delete("/v1/custom-mcp-resources/:resourceId", async (context) => {
    const principal = principalOf(context);
    const resources = new CustomMcpResourceStore(options.controlDatabase);
    const resource = resources.getForPrincipal(context.req.param("resourceId"), principal);
    if (!resource || resource.ownerId !== principal.ownerId)
      return jsonError(context, 404, "custom_mcp_not_found", "Custom MCP resource was not found.");
    if (options.applicationCenter && resource.mseResourceId) {
      await options.applicationCenter.registry.deleteResource(
        resource.mseResourceId,
        {
          spaceId: options.applicationCenter.spaceId,
          ...(options.applicationCenter.resourceMode === "user" && options.applicationCenter.clawId
            ? { clawId: options.applicationCenter.clawId }
            : {}),
          ...(options.applicationCenter.resourceMode === "user" &&
          (principal.userPoolUserUid ?? options.applicationCenter.userPoolUserUid)
            ? { userPoolUserUid: principal.userPoolUserUid ?? options.applicationCenter.userPoolUserUid }
            : {}),
        },
        context.req.raw.signal,
      );
    }
    return resources.revoke(resource.resourceId, principal)
      ? new Response(null, { status: 204 })
      : jsonError(context, 404, "custom_mcp_not_found", "Custom MCP resource was not found.");
  });
  app.get("/v1/app-resources", (context) => {
    const resources = new TenantAppResourceStore(options.controlDatabase);
    return context.json({
      items: resources
        .listForPrincipal(principalOf(context))
        .map((resource) => appResourceResponse(resource, options.publicOrigin)),
    });
  });
  app.delete("/v1/app-resources/:resourceId", async (context) => {
    const resources = new TenantAppResourceStore(options.controlDatabase);
    const principal = principalOf(context);
    const existing = resources.getForPrincipal(context.req.param("resourceId"), principal);
    if (!existing) return jsonError(context, 404, "app_resource_not_found", "App resource was not found.");
    if (options.applicationCenter && existing.mseResourceId) {
      await options.applicationCenter.registry.deleteResource(
        existing.mseResourceId,
        {
          spaceId: options.applicationCenter.spaceId,
          ...(options.applicationCenter.resourceMode === "user" && options.applicationCenter.clawId
            ? { clawId: options.applicationCenter.clawId }
            : {}),
          ...(options.applicationCenter.resourceMode === "user" &&
          (principal.userPoolUserUid ?? options.applicationCenter.userPoolUserUid)
            ? { userPoolUserUid: principal.userPoolUserUid ?? options.applicationCenter.userPoolUserUid }
            : {}),
        },
        context.req.raw.signal,
      );
    }
    return resources.revoke(context.req.param("resourceId"), principal)
      ? new Response(null, { status: 204 })
      : jsonError(context, 404, "app_resource_not_found", "App resource was not found.");
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
    new TenantAppResourceStore(options.controlDatabase).revokeByConnection(connectionId, principal);
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
    const principal = principalOf(context);
    const runtime = tenantRuntime(options, principal);
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
      if (connection.credentialMode === "managed") {
        const credential = await resolveManagedConnectionCredential(
          runtime,
          connection,
          principal,
          connectionId,
          context.req.raw.signal,
        );
        await runtime.connectionService.validateResolvedCredential(
          connection.service,
          credential,
          context.req.raw.signal,
        );
      } else {
        await runtime.connectionService.validateStoredConnection(
          connection.service,
          connection.connectionName,
          context.req.raw.signal,
        );
      }
      jobs.succeed(job.id, { validated: true });
      runtime.connections.setStatus(connectionId, "ready");
    } catch (error) {
      jobs.fail(job.id, {
        code:
          error instanceof ConnectionError || error instanceof CredentialAuthorizationRequiredError
            ? error.code
            : "validation_failed",
        message: error instanceof Error ? error.message : "Connection validation failed.",
        ...(error instanceof CredentialAuthorizationRequiredError ? { authorizationUrl: error.authorizationUrl } : {}),
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
        const managedCredential =
          connection.credentialMode === "managed"
            ? await resolveManagedConnectionCredential(
                runtime,
                connection,
                principalOf(context),
                connectionId,
                context.req.raw.signal,
              )
            : undefined;
        const getCredential = managedCredential
          ? async (service: string) =>
              service === connection.service
                ? mergeResolvedCredential(await execution.getCredential(service), managedCredential)
                : undefined
          : execution.getCredential;
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
              { getCredential, signal: context.req.raw.signal },
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
        const code =
          error instanceof ConnectionError || error instanceof CredentialAuthorizationRequiredError
            ? error.code
            : "discovery_failed";
        jobs.fail(job.id, {
          code,
          message: error instanceof Error ? error.message : "Connection resource discovery failed.",
          ...(error instanceof CredentialAuthorizationRequiredError
            ? { authorizationUrl: error.authorizationUrl }
            : {}),
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
      const credentialRef = optionalString(body.credentialRef);
      if (credentialRef) {
        if (service !== "oracle_database" || authType !== "custom_credential") {
          return jsonError(
            context,
            400,
            "unsupported_credential_ref",
            "Credential references currently support Oracle custom credentials.",
          );
        }
        const values = oracleReferenceValues(recordOf(body.values));
        const stored = await runtime.connections.setCredentialReference(service, connectionName, credentialRef, values);
        profile = await runtime.connectionService.getConnectionSummary(service, stored.connectionName);
      } else if (authType === "api_key") {
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
  app.post("/mcp/apps/:resourceId", async (context) =>
    handleArkClawMcp(context, options, context.req.param("resourceId")),
  );
  app.get("/mcp/apps/:resourceId", (context) => rejectMcpMethod(context));
  app.delete("/mcp/apps/:resourceId", (context) => rejectMcpMethod(context));
  app.post("/mcp/arkclaw", async (context) => handleArkClawMcp(context, options));
  app.get("/mcp/arkclaw", (context) => rejectMcpMethod(context));
  app.delete("/mcp/arkclaw", (context) => rejectMcpMethod(context));
  app.all("/mcp/custom/:resourceId", async (context) =>
    handleCustomMcpProxy(context, options, context.req.param("resourceId")),
  );
  return app;
}

async function handleArkClawMcp(
  context: Context,
  options: ConnectionControlAppOptions,
  pathResourceId?: string,
): Promise<Response> {
  if (!options.arkclaw) return jsonError(context, 404, "arkclaw_not_configured", "ArkClaw MCP is not configured.");
  const arkclaw = options.arkclaw;
  const headerResourceId = context.req.header("x-app-resourceid") ?? context.req.header("x-app-resource-id");
  const resourceId = pathResourceId ?? headerResourceId;
  if (!resourceId) return jsonError(context, 400, "resource_required", "X-App-ResourceId is required.");
  const resources = new TenantAppResourceStore(options.controlDatabase);
  const candidate = pathResourceId
    ? resources.getById(pathResourceId)
    : headerResourceId
      ? (resources.getById(headerResourceId) ?? resources.getByMseResourceId(headerResourceId))
      : undefined;
  if (pathResourceId && headerResourceId && candidate) {
    const expectedGatewayResourceId = candidate.mseResourceId ?? candidate.resourceId;
    if (headerResourceId !== expectedGatewayResourceId) {
      return jsonError(context, 400, "resource_mismatch", "X-App-ResourceId does not match this MCP resource.");
    }
  }
  const apiKey = readBearer(context);
  const oauthToken =
    candidate?.ingressAuth === "oauth2"
      ? apiKey && arkclaw.verifyOAuthToken
        ? await arkclaw.verifyOAuthToken(apiKey, context.req.raw.signal)
        : undefined
      : undefined;
  const authenticated =
    candidate?.ingressAuth === "oauth2"
      ? Boolean(oauthToken)
      : verifyApiKey(
          apiKey,
          candidate?.ingressApiKeyHashes.length ? candidate.ingressApiKeyHashes : arkclaw.apiKeyHashes,
        );
  if (!authenticated) {
    return jsonError(context, 401, "unauthorized", "Valid ArkClaw ingress authentication is required.");
  }
  if (!candidate)
    return jsonError(context, 403, "resource_forbidden", "The app resource is not available to this user.");
  const localResourceId = candidate.resourceId;
  const tip = context.req.header("x-ve-tip-token") ?? context.req.header("x-arkclaw-jwt");
  if (!tip) return jsonError(context, 401, "tip_required", "X-Ve-TIP-Token is required.");
  let verified;
  try {
    verified = await arkclaw.verifyTip(tip, context.req.raw.signal);
  } catch {
    return jsonError(context, 401, "tip_invalid", "TIP token is invalid.");
  }
  if (!candidate || candidate.tenantId !== verified.principal.tenantId) {
    return jsonError(context, 403, "resource_forbidden", "The app resource is not available to this user.");
  }
  const tipPrincipal = {
    ...verified.principal,
    tenantId: candidate.tenantId,
    workspaceId: candidate.workspaceId,
  };
  if (oauthToken && !oauthTokenMatchesTip(oauthToken, tipPrincipal, candidate.oauthIdentityClaims)) {
    return jsonError(context, 403, "oauth_tip_mismatch", "OAuth access token and TIP identify different users.");
  }
  if (oauthToken && !hasRequiredOAuthScopes(oauthToken, candidate.requiredOAuthScopes)) {
    return jsonError(context, 403, "oauth_scope_denied", "OAuth access token does not grant the required scopes.");
  }
  if (
    oauthToken &&
    candidate.allowedOAuthClientIds.length > 0 &&
    (!oauthToken.clientId || !candidate.allowedOAuthClientIds.includes(oauthToken.clientId))
  ) {
    return jsonError(
      context,
      403,
      "oauth_client_denied",
      "OAuth client is not allowed to access this application resource.",
    );
  }
  const resource = resources.getForPrincipal(localResourceId, tipPrincipal);
  if (!resource)
    return jsonError(context, 403, "resource_forbidden", "The app resource is not available to this user.");
  const executionPrincipal = { ...tipPrincipal, ownerId: resource.ownerId };
  const runtime = tenantRuntime(options, executionPrincipal);
  if (!runtime.connections.visibleRecord(resource.connectionId)) {
    return jsonError(
      context,
      403,
      "connection_forbidden",
      "The app resource connection is not available to this user.",
    );
  }
  const authorization = await authorizeMcpRequest(context, options, resource, tipPrincipal, {
    authentication: candidate?.ingressAuth === "oauth2" ? "bearer_user" : "api_key_m2m",
  });
  if (!authorization.allowed) {
    return jsonError(
      context,
      403,
      "mcp_authorization_denied",
      authorization.reason ?? "MCP request is not authorized.",
    );
  }
  const handler = createMcpHandler(
    () =>
      createArkClawMcpServer(
        {
          catalog: options.catalog,
          providerLoader: options.providerLoader,
          controlDatabase: options.controlDatabase,
          secretCodec: options.secretCodec,
          publicOrigin: options.publicOrigin,
          transitFiles: options.transitFiles,
          credentialBroker: arkclaw.credentialBroker,
        },
        {
          resource,
          principal: executionPrincipal,
          actorPrincipal: tipPrincipal,
          signal: context.req.raw.signal,
          authentication: candidate?.ingressAuth === "oauth2" ? "bearer_user" : "api_key_m2m",
          authorizer: arkclaw.authorizer,
        },
      ),
    { legacy: "stateless", responseMode: "json" },
  );
  try {
    return await handler.fetch(context.req.raw);
  } finally {
    await handler.close();
  }
}

async function authorizeMcpRequest(
  context: Context,
  options: ConnectionControlAppOptions,
  resource: AppResourceRecord,
  principal: TenantPrincipal,
  input: { authentication: "api_key_m2m" | "bearer_user" },
): Promise<{ allowed: boolean; reason?: string }> {
  const body = (await context.req.raw
    .clone()
    .json()
    .catch(() => undefined)) as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | undefined;
  const method = typeof body?.method === "string" ? body.method : undefined;
  if (method !== "tools/list" && method !== "tools/call") return { allowed: true };
  const phase = method === "tools/call" ? "execution" : "discovery";
  let actionId: string | undefined;
  if (phase === "execution" && typeof body?.params?.name === "string") {
    actionId = options.catalog.actions.find(
      (action) => action.name === body.params?.name || action.id === body.params?.name,
    )?.id;
    actionId ??= resource.allowedActions.find((candidate) => {
      const action = options.catalog.actionsById.get(candidate);
      return action?.name === body.params?.name || action?.id === body.params?.name;
    });
  }
  const authorizer = options.arkclaw?.authorizer;
  return authorizerDecision(
    await authorizeMcp(authorizer, {
      phase,
      principal,
      resource,
      actionId,
      authentication: input.authentication,
      request: context.req.raw,
    }),
  );
}

function authorizerDecision(decision: { allowed: boolean; reason?: string }): {
  allowed: boolean;
  reason?: string;
} {
  return decision;
}

async function handleCustomMcpProxy(
  context: Context,
  options: ConnectionControlAppOptions,
  pathResourceId: string,
): Promise<Response> {
  if (!options.arkclaw) return jsonError(context, 404, "arkclaw_not_configured", "ArkClaw MCP is not configured.");
  const arkclaw = options.arkclaw;
  const headerResourceId = context.req.header("x-app-resourceid") ?? context.req.header("x-app-resource-id");
  const resources = new CustomMcpResourceStore(options.controlDatabase);
  const candidate = resources.getById(pathResourceId) ?? resources.getByMseResourceId(pathResourceId);
  if (!candidate) return jsonError(context, 403, "resource_forbidden", "The MCP resource is not available.");
  if (headerResourceId && headerResourceId !== candidate.resourceId && headerResourceId !== candidate.mseResourceId) {
    return jsonError(context, 400, "resource_mismatch", "X-App-ResourceId does not match this MCP resource.");
  }
  const bearer = readBearer(context);
  let oauthToken: VerifiedOAuthAccessToken | undefined;
  if (candidate.ingressAuth === "oauth2" && bearer && arkclaw.verifyOAuthToken) {
    oauthToken = await arkclaw.verifyOAuthToken(bearer, context.req.raw.signal).catch(() => undefined);
  }
  const hasResourceIngressKey = candidate.ingressApiKeyHashes.length > 0;
  const gatewayResourceMatch = Boolean(candidate.mseResourceId && headerResourceId === candidate.mseResourceId);
  const authenticated =
    candidate.ingressAuth === "oauth2"
      ? Boolean(oauthToken) || (Boolean(candidate.credentialProviderName) && gatewayResourceMatch)
      : hasResourceIngressKey
        ? verifyApiKey(bearer, candidate.ingressApiKeyHashes)
        : (Boolean(candidate.credentialProviderName) && gatewayResourceMatch) ||
          verifyApiKey(bearer, arkclaw.apiKeyHashes);
  if (!authenticated) return jsonError(context, 401, "unauthorized", "Valid MCP ingress authentication is required.");
  const tip = context.req.header("x-ve-tip-token") ?? context.req.header("x-arkclaw-jwt");
  if (!tip) return jsonError(context, 401, "tip_required", "X-Ve-TIP-Token is required.");
  let verified;
  try {
    verified = await arkclaw.verifyTip(tip, context.req.raw.signal);
  } catch {
    return jsonError(context, 401, "tip_invalid", "TIP token is invalid.");
  }
  if (candidate.tenantId !== verified.principal.tenantId)
    return jsonError(context, 403, "resource_forbidden", "The MCP resource is not available.");
  const principal = { ...verified.principal, tenantId: candidate.tenantId, workspaceId: candidate.workspaceId };
  if (oauthToken && !oauthTokenMatchesTip(oauthToken, principal, candidate.oauthIdentityClaims))
    return jsonError(context, 403, "oauth_tip_mismatch", "OAuth access token and TIP identify different users.");
  if (oauthToken && !hasRequiredOAuthScopes(oauthToken, candidate.requiredOAuthScopes))
    return jsonError(context, 403, "oauth_scope_denied", "OAuth access token does not grant the required scopes.");
  if (
    oauthToken &&
    candidate.allowedOAuthClientIds.length > 0 &&
    (!oauthToken.clientId || !candidate.allowedOAuthClientIds.includes(oauthToken.clientId))
  )
    return jsonError(context, 403, "oauth_client_denied", "OAuth client is not allowed to access this MCP resource.");
  if (!resources.getForPrincipal(candidate.resourceId, principal))
    return jsonError(context, 403, "resource_forbidden", "The MCP resource is not available to this user.");
  return proxyCustomMcp(context, candidate, {
    allowPrivateNetwork: candidate.allowPrivateNetwork && options.customMcp?.allowPrivateNetwork === true,
    timeoutMs: options.customMcp?.proxyTimeoutMs,
    fetcher: options.customMcp?.fetcher,
    skipDnsValidation: options.customMcp?.skipDnsValidation,
  });
}

function oauthTokenMatchesTip(
  token: VerifiedOAuthAccessToken,
  principal: TenantPrincipal,
  identityClaims: readonly string[],
): boolean {
  const identities = new Set([principal.ownerId, principal.subject]);
  return identityClaims.some((claim) => {
    const value = readClaimPath(token.claims, claim);
    return typeof value === "string" && identities.has(value);
  });
}

function hasRequiredOAuthScopes(token: VerifiedOAuthAccessToken, required: readonly string[]): boolean {
  const granted = new Set(token.scopes);
  return required.every((scope) => granted.has(scope));
}

function readClaimPath(claims: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, segment) =>
        value && typeof value === "object" ? (value as Record<string, unknown>)[segment] : undefined,
      claims,
    );
}

function appResourceResponse(resource: import("./app-resource-store.ts").AppResourceRecord, publicOrigin: string) {
  return {
    ...resource,
    ingressApiKeyHashes: resource.ingressApiKeyHashes.map(() => "[redacted]"),
    mcpUrl: new URL(`/mcp/apps/${encodeURIComponent(resource.resourceId)}`, publicOrigin).toString(),
    ...(resource.mseGatewayUrl && resource.mseResourceId
      ? {
          gateway: {
            url: resource.mseGatewayUrl,
            headers: {
              "X-App-ResourceId": resource.mseResourceId,
              "X-Ve-TIP-Token": "${VE_TIP_TOKEN}",
            },
          },
        }
      : {}),
  };
}

function customMcpResourceResponse(
  resource: import("./custom-mcp-resource-store.ts").CustomMcpResourceRecord,
  publicOrigin: string,
) {
  return {
    ...resource,
    ingressApiKeyHashes: resource.ingressApiKeyHashes.map(() => "[redacted]"),
    mcpUrl: new URL(`/mcp/custom/${encodeURIComponent(resource.resourceId)}`, publicOrigin).toString(),
    ...(resource.mseGatewayUrl
      ? {
          gateway: {
            url: resource.mseGatewayUrl,
            urlType: resource.mseGatewayUrlType,
            headers: {
              "X-App-ResourceId": resource.mseResourceId ?? resource.resourceId,
              "X-Ve-TIP-Token": "${VE_TIP_TOKEN}",
            },
          },
        }
      : {}),
  };
}

function parseProxyCredential(
  value: unknown,
): { ingressAuth: "api_key" | "oauth2"; authConfig: ApplicationCenterAuthConfig; providerNames: string[] } | undefined {
  if (value === undefined) return undefined;
  const input = recordOf(value);
  const mode = input.mode;
  if (mode !== "reference") {
    throw new Error("proxyCredential.mode must be reference.");
  }
  const type = input.type;
  const providerName = input.credentialProviderName;
  if ((type !== "api_key" && type !== "oauth2") || !requiredNonEmpty(providerName)) {
    throw new Error("proxyCredential requires type api_key/oauth2 and credentialProviderName.");
  }
  if (type === "api_key") {
    return {
      ingressAuth: "api_key",
      authConfig: { Type: "KEY_AUTH", ApikeyConfig: [{ CredentialProviderName: providerName.trim() }] },
      providerNames: [providerName.trim()],
    };
  }
  const flow = input.flow === undefined ? "USER_FEDERATION" : input.flow;
  if (!requiredNonEmpty(flow)) throw new Error("proxyCredential.flow must be a non-empty string.");
  return {
    ingressAuth: "oauth2",
    authConfig: { Type: "OAUTH", OAuthConfig: [{ CredentialProviderName: providerName.trim(), Flow: flow }] },
    providerNames: [providerName.trim()],
  };
}

function parseCredentialAuthConfig(value: unknown): CredentialAuthConfig | undefined {
  if (value === undefined) return undefined;
  const input = recordOf(value);
  const type = input.Type === "oauth2" || input.Type === "api_key" ? input.Type : undefined;
  if (!type) throw new Error("credentialAuthConfig.Type must be api_key or oauth2.");
  if (type === "oauth2") {
    const configs = input.OAuthConfig;
    if (!Array.isArray(configs) || configs.length === 0) {
      throw new Error("OAuth credentialAuthConfig requires a non-empty OAuthConfig array.");
    }
    for (const item of configs) {
      const config = recordOf(item);
      const provider = recordOf(config.Oauth2ProviderConfig);
      if (!requiredNonEmpty(config.Vendor) || !requiredNonEmpty(config.Name) || !requiredNonEmpty(provider.ClientId)) {
        throw new Error("Each OAuth credential requires Vendor, Name, and Oauth2ProviderConfig.ClientId.");
      }
      const discovery = recordOf(provider.Oauth2Discovery);
      if (discovery.DiscoveryUrl !== undefined) {
        assertHttpsUrl(discovery.DiscoveryUrl, "Oauth2Discovery.DiscoveryUrl");
      }
      if (provider.ClientSecret !== undefined && typeof provider.ClientSecret !== "string") {
        throw new Error("Oauth2ProviderConfig.ClientSecret must be a string.");
      }
      if (provider.Scopes !== undefined) stringArray(provider.Scopes);
    }
  } else {
    const configs = input.ApikeyConfig;
    if (!Array.isArray(configs) || configs.length === 0) {
      throw new Error("API key credentialAuthConfig requires a non-empty ApikeyConfig array.");
    }
    for (const item of configs) {
      const config = recordOf(item);
      if (!requiredNonEmpty(config.Name) || !requiredNonEmpty(config.ApiKey)) {
        throw new Error("Each API key credential requires Name and ApiKey.");
      }
      if (config.ApiKeyMetadata !== undefined) {
        if (!Array.isArray(config.ApiKeyMetadata) || config.ApiKeyMetadata.length === 0) {
          throw new Error("ApiKeyMetadata must be a non-empty array when provided.");
        }
        for (const metadata of config.ApiKeyMetadata) {
          const itemMetadata = recordOf(metadata);
          if (!requiredNonEmpty(itemMetadata.Location) || !requiredNonEmpty(itemMetadata.ParameterName)) {
            throw new Error("Each API key metadata item requires Location and ParameterName.");
          }
          if (itemMetadata.Prefix !== undefined && typeof itemMetadata.Prefix !== "string") {
            throw new Error("API key metadata Prefix must be a string.");
          }
        }
      }
    }
  }
  return input as unknown as CredentialAuthConfig;
}

function requiredNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertHttpsUrl(value: unknown, field: string): void {
  if (typeof value !== "string") throw new Error(`${field} must be an HTTPS URL.`);
  try {
    if (new URL(value).protocol !== "https:") throw new Error();
  } catch {
    throw new Error(`${field} must be an HTTPS URL.`);
  }
}

function credentialProviderNames(value: unknown): string[] {
  const config = parseCredentialAuthConfig(value);
  return [
    ...(config?.OAuthConfig ?? []).map((item) => item.Name),
    ...(config?.ApikeyConfig ?? []).map((item) => item.Name),
  ].filter((name): name is string => typeof name === "string" && Boolean(name.trim()));
}

function rejectMcpMethod(context: Context): Response {
  return context.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405);
}

function verifyApiKey(value: string | undefined, hashes: readonly string[]): boolean {
  if (!value) return false;
  const actual = Buffer.from(sha256(value), "hex");
  return hashes
    .filter((hash) => /^[a-f0-9]{64}$/iu.test(hash.trim()))
    .some((hash) => {
      const expected = Buffer.from(hash.trim(), "hex");
      return expected.length === actual.length && timingSafeEqual(actual, expected);
    });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
      credentialBroker: options.arkclaw?.credentialBroker,
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
  const match = value?.match(/^Bearer\s+(\S+)$/iu);
  return match?.[1];
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

function stringArrayOptional(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return stringArray(value);
}

function optionalIngressAuth(value: unknown): "api_key" | "oauth2" | undefined {
  if (value === undefined) return undefined;
  if (value === "api_key" || value === "oauth2") return value;
  throw new Error("ingressAuth must be api_key or oauth2.");
}

function assertCustomMcpUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    if (url.username || url.password || url.hash) throw new Error();
  } catch {
    throw new Error("upstreamUrl must be an HTTP(S) URL without credentials or a fragment.");
  }
}

function parseCustomMcpProtocol(value: unknown): "http" | "sse" | "streamable_http" {
  if (value === undefined || value === "streamable_http") return "streamable_http";
  if (value === "http") return "http";
  if (value === "sse") return "sse";
  throw new Error("protocol must be streamable_http or sse.");
}

function parseCustomMcpVisibility(value: unknown): CustomMcpVisibility {
  if (value === undefined || value === "personal") return "personal";
  if (value === "team" || value === "partial") return value;
  throw new Error("visibility must be personal, team, or partial.");
}

function parseCustomMcpCredential(
  value: unknown,
): { type: "api_key" | "oauth2"; providerName: string; authConfig: ApplicationCenterAuthConfig } | undefined {
  if (value === undefined) return undefined;
  const input = recordOf(value);
  if (input.mode !== "reference" || !requiredNonEmpty(input.credentialProviderName)) {
    throw new Error("proxyCredential requires mode=reference and credentialProviderName.");
  }
  const providerName = input.credentialProviderName.trim();
  if (input.type === "api_key") {
    return {
      type: "api_key",
      providerName,
      authConfig: { Type: "KEY_AUTH", ApikeyConfig: [{ CredentialProviderName: providerName }] },
    };
  }
  if (input.type === "oauth2") {
    const flow = input.flow === undefined ? "USER_FEDERATION" : requiredString(input.flow);
    return {
      type: "oauth2",
      providerName,
      authConfig: { Type: "OAUTH", OAuthConfig: [{ CredentialProviderName: providerName, Flow: flow }] },
    };
  }
  throw new Error("proxyCredential.type must be api_key or oauth2.");
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

function oracleReferenceValues(value: Record<string, unknown>): Record<string, string> {
  const allowed = new Set([
    "host",
    "port",
    "database",
    "tls",
    "caCertificate",
    "serviceName",
    "sid",
    "allowedSchemas",
    "allowedTables",
  ]);
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`Unexpected Oracle connection field: ${key}.`);
    if (typeof raw !== "string" && typeof raw !== "number") throw new Error(`${key} must be a string or number.`);
    const normalized = String(raw).trim();
    if (normalized) output[key] = normalized;
  }
  if (!output.host || (!output.serviceName && !output.sid) || (output.serviceName && output.sid)) {
    throw new Error("Broker-backed Oracle connections require host and exactly one of serviceName or sid.");
  }
  return output;
}

async function resolveManagedConnectionCredential(
  runtime: ReturnType<typeof tenantRuntime>,
  connection: ConnectionRecord,
  principal: TenantPrincipal,
  resourceId: string,
  signal?: AbortSignal,
): Promise<ResolvedCredential> {
  if (!runtime.credentialBroker) {
    throw new ConnectionError("credential_unavailable", "Credential broker is not configured.");
  }
  const resolved = await runtime.credentialBroker.resolve({
    credentialRef: connection.credentialRef,
    principal,
    resourceId,
    service: connection.service,
    signal,
  });
  if (resolved.status === "authorization_required") {
    throw new CredentialAuthorizationRequiredError(resolved.authorizationUrl);
  }
  if (connection.service === "oracle_database" && resolved.credential.authType !== "custom_credential") {
    throw new ConnectionError("credential_unavailable", "Oracle Credential Broker must return a custom credential.");
  }
  const base = await runtime.connectionService.getCredential(connection.service, connection.connectionName);
  return mergeManagedCredential(base, resolved.credential, connection.service);
}

function mergeResolvedCredential(
  base: ResolvedCredential | undefined,
  resolved: ResolvedCredential,
): ResolvedCredential {
  if (base?.authType === "custom_credential" && resolved.authType === "custom_credential") {
    return { ...resolved, values: { ...base.values, ...resolved.values } };
  }
  return resolved;
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
