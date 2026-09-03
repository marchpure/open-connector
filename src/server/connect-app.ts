import type { CatalogStore } from "../catalog-store.ts";
import type { ActionPolicyService } from "../core/action-policy.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { RuntimeJwtVerifier } from "./api/runtime-jwt.ts";
import type { ITransitFileService, TransitFileUpload } from "./files/transit-file-store.ts";
import type { Logger } from "./logger.ts";
import type { ISecretCodec } from "./secrets/secret-codec-core.ts";
import type { RuntimeDatabase } from "./storage/runtime-database.ts";
import type { Hono } from "hono";

import { ConnectionService } from "../connection-service.ts";
import { OAuthClientConfigService } from "../oauth/oauth-client-config-service.ts";
import { OAuthCredentialRefreshService } from "../oauth/oauth-credential-refresh-service.ts";
import { OAuthFlowService } from "../oauth/oauth-flow-service.ts";
import { ActionRunner } from "./actions/action-runner.ts";
import { registerOAuthCompatRoutes } from "./api/oauth-compat.ts";
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
}

export interface ConnectApp {
  app: Hono;
  runtimeAuthConfigured: boolean;
}

export async function createConnectApp(options: ConnectAppOptions): Promise<ConnectApp> {
  const runtimeTokens = new RuntimeTokenService(options.runtimeDatabase.runtimeTokenStore, options.logger);
  const hasStoredRuntimeTokens = async (): Promise<boolean> => (await runtimeTokens.listTokens()).length > 0;
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
  });
  const actions = new ActionRunner({
    catalog: options.catalog,
    providerLoader: options.providerLoader,
    connections,
    runs: options.runtimeDatabase.runLogStore,
    transitFiles: options.transitFiles,
    actionPolicy: options.actionPolicy,
    logger: options.logger,
  });

  const oauthCompatEnabled = process.env.OPENCONNECTOR_OAUTH_COMPAT_ENABLED === "true";
  const oauthUpstreamIssuer = process.env.OPENCONNECTOR_OAUTH_UPSTREAM_ISSUER?.trim();
  const oauthClientId = process.env.OPENCONNECTOR_OAUTH_CLIENT_ID?.trim();
  const oauthStateSecret = process.env.OPENCONNECTOR_OAUTH_STATE_SECRET?.trim();
  if (oauthCompatEnabled && (!oauthUpstreamIssuer || !oauthClientId || !oauthStateSecret)) {
    throw new Error(
      "OPENCONNECTOR_OAUTH_UPSTREAM_ISSUER, OPENCONNECTOR_OAUTH_CLIENT_ID, and OPENCONNECTOR_OAUTH_STATE_SECRET are required.",
    );
  }

  const connectServer = new ConnectServer({
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
        resolveRuntimeToken: (token) => runtimeTokens.resolveToken(token),
        verifyRuntimeJwt: options.verifyRuntimeJwt,
        oauthResourceMetadataUrl: oauthCompatEnabled
          ? `${options.publicOrigin}/.well-known/oauth-protected-resource/mcp`
          : undefined,
      },
      actionPolicy: options.actionPolicy,
      logger: options.logger,
      compressApiResponses: options.compressApiResponses,
      registerPreAuthRoutes: oauthCompatEnabled
        ? (app) =>
            registerOAuthCompatRoutes(app, {
              origin: options.publicOrigin,
              upstreamIssuer: oauthUpstreamIssuer!,
              clientId: oauthClientId!,
              clientSecret: process.env.OPENCONNECTOR_OAUTH_CLIENT_SECRET,
              stateSecret: oauthStateSecret!,
              scopes: process.env.OPENCONNECTOR_OAUTH_SCOPES,
            })
        : undefined,
    });
  return {
    app: connectServer.createApp(),
    runtimeAuthConfigured:
      Boolean(options.runtimeToken) ||
      Boolean(options.verifyRuntimeJwt) ||
      (options.computeRuntimeAuthConfigured === false ? false : await hasStoredRuntimeTokens()),
  };
}
