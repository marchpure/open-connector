import type { CatalogStore } from "../catalog-store.ts";
import type { ActionPolicySnapshot } from "../core/action-policy.ts";
import type { TransitFileWriter } from "../core/types.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { ConnectionLeaseClaims, TenantPrincipal } from "./types.ts";
import type { ConnectionRecord } from "./types.ts";
import type { DatabaseSync } from "node:sqlite";

import { ConnectionService } from "../connection-service.ts";
import { ActionPolicyService as PolicyService } from "../core/action-policy.ts";
import { OAuthClientConfigService } from "../oauth/oauth-client-config-service.ts";
import { OAuthCredentialRefreshService } from "../oauth/oauth-credential-refresh-service.ts";
import { OAuthFlowService } from "../oauth/oauth-flow-service.ts";
import { ActionRunner } from "../server/actions/action-runner.ts";
import { ConnectionLeaseService } from "./lease.ts";
import { TenantResourceStore } from "./resource-store.ts";
import {
  TenantConnectionStore as ConnectionStore,
  TenantOAuthClientConfigStore,
  TenantOAuthStateStore,
  TenantRunLogStore,
} from "./tenant-store.ts";

export interface ControlPlaneDependencies {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  controlDatabase: DatabaseSync;
  secretCodec: ISecretCodec;
  publicOrigin: string;
  transitFiles?: TransitFileWriter;
  webEgress?: WebEgressPolicy;
}

export interface WebEgressPolicy {
  allowLocalhostDev?: boolean;
  allowedLocalhostPorts?: readonly number[];
}

export interface TenantRuntime {
  principal: TenantPrincipal;
  connections: ConnectionStore;
  connectionService: ConnectionService;
  actions: ActionRunner;
  runs: TenantRunLogStore;
  leases: ConnectionLeaseService;
  records: () => Promise<ConnectionRecord[]>;
  oauthFlow: OAuthFlowService;
  oauthClientConfigs: OAuthClientConfigService;
  resources: TenantResourceStore;
}

export function createTenantRuntime(deps: ControlPlaneDependencies, principal: TenantPrincipal): TenantRuntime {
  const connections = new ConnectionStore(deps.controlDatabase, principal, deps.secretCodec);
  const oauthClientConfigs = new OAuthClientConfigService({
    catalog: deps.catalog,
    origin: deps.publicOrigin,
    store: new TenantOAuthClientConfigStore(deps.controlDatabase, principal, deps.secretCodec),
    isCustomClientConfigAvailable: () => deps.secretCodec.encrypted,
  });
  const connectionService = new ConnectionService({
    catalog: deps.catalog,
    oauthCredentials: new OAuthCredentialRefreshService(oauthClientConfigs),
    providerLoader: deps.providerLoader,
    store: connections,
  });
  const runs = new TenantRunLogStore(deps.controlDatabase, principal);
  const resources = new TenantResourceStore(deps.controlDatabase, principal);
  const actions = new ActionRunner({
    catalog: deps.catalog,
    providerLoader: deps.providerLoader,
    connections: connectionService,
    runs,
    transitFiles: deps.transitFiles,
    resourceAuthorization: resources,
  });
  return {
    principal,
    connections,
    oauthFlow: new OAuthFlowService({
      clientConfigs: oauthClientConfigs,
      connections: connectionService,
      states: new TenantOAuthStateStore(deps.controlDatabase, principal, deps.secretCodec),
      secretCodec: deps.secretCodec,
      isCustomClientConfigAllowed: () => deps.secretCodec.encrypted,
      principal,
    }),
    connectionService,
    actions,
    runs,
    leases: new ConnectionLeaseService(deps.controlDatabase),
    records: () => connections.listRecords(),
    oauthClientConfigs,
    resources,
  };
}

export function createLeasePolicy(claims: ConnectionLeaseClaims): ActionPolicySnapshot {
  return new PolicyService().createSnapshot(undefined, {
    allowedActions: claims.allowedActions,
    blockedActions: [],
    allowedProxies: [],
    allowedConnections: claims.connectionIds,
  });
}
