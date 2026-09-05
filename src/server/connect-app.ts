import type { CatalogStore } from "../catalog-store.ts";
import type { ActionPolicyService } from "../core/action-policy.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { McpAuthorizer } from "./api/mcp-authorizer.ts";
import type { RuntimeJwtVerifier } from "./api/runtime-jwt.ts";
import type { ConnectServerRole } from "./connect-server.ts";
import type { ITransitFileService, TransitFileUpload } from "./files/transit-file-store.ts";
import type { Logger } from "./logger.ts";
import type { ISecretCodec } from "./secrets/secret-codec-core.ts";
import type { RuntimeDatabase } from "./storage/runtime-database.ts";
import type { Hono } from "hono";

import { ConnectionService } from "../connection-service.ts";
import { MarketplaceService } from "../marketplace/marketplace-service.ts";
import { OAuthClientConfigService } from "../oauth/oauth-client-config-service.ts";
import { OAuthCredentialRefreshService } from "../oauth/oauth-credential-refresh-service.ts";
import { OAuthFlowService } from "../oauth/oauth-flow-service.ts";
import { AccessGrantService } from "./access/access-grants.ts";
import { ActionRunner } from "./actions/action-runner.ts";
import { registerOAuthCompatRoutes } from "./api/oauth-compat.ts";
import { createRuntimeJwtVerifierFromIdentityConfig } from "./api/runtime-jwt.ts";
import { ConnectServer } from "./connect-server.ts";
import { RuntimeTokenService } from "./storage/runtime-token-service.ts";

export interface ConnectAppOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  runtimeDatabase: RuntimeDatabase;
  transitFiles: ITransitFileService;
  uploadTransitFile?: (request: Request) => Promise<TransitFileUpload>;
  publicOrigin: string;
  secretCodec: ISecretCodec;
  adminToken?: string;
  runtimeToken?: string;
  allowedCustomOAuth?: string[];
  verifyRuntimeJwt?: RuntimeJwtVerifier;
  actionPolicy?: ActionPolicyService;
  registerStaticRoutes?: (app: Hono) => void;
  logger?: Logger;
  computeRuntimeAuthConfigured?: boolean;
  compressApiResponses?: boolean;
  mcpAuthorizer?: McpAuthorizer;
  role?: ConnectServerRole;
}

export interface ConnectApp {
  app: Hono;
  runtimeAuthConfigured: boolean;
}

export async function createConnectApp(options: ConnectAppOptions): Promise<ConnectApp> {
  const marketplace = new MarketplaceService({
    catalog: options.catalog,
    store: options.runtimeDatabase.marketplaceStore,
    secretCodec: options.secretCodec,
  });
  await marketplace.initialize();
  const runtimeTokens = new RuntimeTokenService(options.runtimeDatabase.runtimeTokenStore, options.logger);
  const accessGrants = new AccessGrantService(options.runtimeDatabase.accessGrantStore);
  const hasStoredRuntimeTokens = async (): Promise<boolean> => (await runtimeTokens.listTokens()).length > 0;
  const hasRuntimeJwtConfig = async (): Promise<boolean> =>
    Boolean(options.verifyRuntimeJwt) || Boolean(await accessGrants.getIdentityProviderConfig());
  const allowedCustomOAuth = new Set(options.allowedCustomOAuth);
  const isCustomClientConfigAllowed = (service: string): boolean =>
    allowedCustomOAuth.has("*") || allowedCustomOAuth.has(service);
  const oauthClientConfigs = new OAuthClientConfigService({
    catalog: options.catalog,
    origin: options.publicOrigin,
    store: options.runtimeDatabase.oauthClientConfigStore,
    isCustomClientConfigAvailable: (service) => options.secretCodec.encrypted && isCustomClientConfigAllowed(service),
  });
  const connections = new ConnectionService({
    catalog: options.catalog,
    oauthCredentials: new OAuthCredentialRefreshService(oauthClientConfigs),
    providerLoader: options.providerLoader,
    store: options.runtimeDatabase.connectionStore,
    logger: options.logger,
    marketplace,
  });
  const actions = new ActionRunner({
    catalog: options.catalog,
    providerLoader: options.providerLoader,
    connections,
    runs: options.runtimeDatabase.runLogStore,
    transitFiles: options.transitFiles,
    actionPolicy: options.actionPolicy,
    logger: options.logger,
    marketplace,
  });
  const oauthCompat = readOAuthCompatEnvironment(options.publicOrigin);

  return {
    app: new ConnectServer({
      catalog: options.catalog,
      providerLoader: options.providerLoader,
      connections,
      oauthClientConfigs,
      oauthFlow: new OAuthFlowService({
        clientConfigs: oauthClientConfigs,
        connections,
        states: options.runtimeDatabase.oauthStateStore,
        secretCodec: options.secretCodec,
        isCustomClientConfigAllowed,
      }),
      actions,
      idempotency: options.runtimeDatabase.idempotencyStore,
      transitFiles: options.transitFiles,
      uploadTransitFile: options.uploadTransitFile,
      runtimeTokens,
      runtimePolicyStore: options.runtimeDatabase.runtimePolicyStore,
      registerStaticRoutes: options.registerStaticRoutes,
      auth: {
        adminToken: options.adminToken,
        runtimeToken: options.runtimeToken,
        hasRuntimeTokens: hasStoredRuntimeTokens,
        hasRuntimeJwtConfig,
        resolveRuntimeToken: (token) => runtimeTokens.resolveToken(token),
        verifyRuntimeJwt:
          options.verifyRuntimeJwt ??
          createRuntimeJwtVerifierFromIdentityConfig(() => accessGrants.getIdentityProviderConfig()),
        oauthResourceMetadataUrl: oauthCompat
          ? `${options.publicOrigin}/.well-known/oauth-protected-resource/mcp`
          : undefined,
      },
      actionPolicy: options.actionPolicy,
      accessGrants,
      logger: options.logger,
      marketplace,
      compressApiResponses: options.compressApiResponses,
      mcpAuthorizer: options.mcpAuthorizer,
      role: options.role,
      registerPreAuthRoutes:
        oauthCompat && options.role !== "mcp-runtime"
          ? (app) =>
              registerOAuthCompatRoutes(app, {
                ...oauthCompat,
                states: options.runtimeDatabase.oauthStateStore,
              })
          : undefined,
    }).createApp(),
    runtimeAuthConfigured:
      Boolean(options.runtimeToken) ||
      Boolean(options.verifyRuntimeJwt) ||
      (options.computeRuntimeAuthConfigured === false ? false : await hasRuntimeJwtConfig()) ||
      (options.computeRuntimeAuthConfigured === false ? false : await hasStoredRuntimeTokens()),
  };
}

function readOAuthCompatEnvironment(origin: string):
  | {
      origin: string;
      upstreamIssuer: string;
      clientId: string;
      clientSecret: string;
      stateSecret: string;
      scopes?: string;
      upstreamPrompt?: "login";
      allowedRedirectUris: string[];
    }
  | undefined {
  if (process.env.OPENCONNECTOR_OAUTH_COMPAT_ENABLED !== "true") return undefined;
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required when OAuth compatibility is enabled.`);
    return value;
  };
  return {
    origin,
    upstreamIssuer: required("OPENCONNECTOR_OAUTH_UPSTREAM_ISSUER"),
    clientId: required("OPENCONNECTOR_OAUTH_CLIENT_ID"),
    clientSecret: required("OPENCONNECTOR_OAUTH_CLIENT_SECRET"),
    stateSecret: required("OPENCONNECTOR_OAUTH_STATE_SECRET"),
    scopes: process.env.OPENCONNECTOR_OAUTH_SCOPES,
    upstreamPrompt: readUpstreamPrompt(process.env.OPENCONNECTOR_OAUTH_UPSTREAM_PROMPT),
    allowedRedirectUris: required("OPENCONNECTOR_OAUTH_ALLOWED_REDIRECT_URIS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

function readUpstreamPrompt(value: string | undefined): "login" | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized === "login") return normalized;
  throw new Error("OPENCONNECTOR_OAUTH_UPSTREAM_PROMPT must be login when configured.");
}
