import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { ProviderResourceCandidate } from "../provider-loader.ts";
import type { NetsuiteContext } from "./runtime.ts";

import { optionalString } from "../../core/cast.ts";
import {
  discoverErpCapabilities,
  erpMaxPages,
  erpMaxResponseBytes,
  erpRequestTimeoutMs,
  withErpConcurrency,
} from "../../core/erp/runtime.ts";
import {
  createProviderTimeout,
  createProviderProxyUrl,
  defineProviderExecutors,
  normalizeProviderProxyHeaders,
  providerFetch,
  ProviderRequestError,
  providerUserAgent,
  readProviderProxyErrorMessage,
  readProviderProxyResponse,
  requireCustomCredential,
  toProviderProxyError,
} from "../provider-runtime.ts";
import { netsuiteEntities } from "./erp.ts";
import {
  buildOAuthAuthorizationHeader,
  netsuiteActionHandlers,
  resolveNetsuiteCredentialContext,
  validateNetsuiteCredential,
} from "./runtime.ts";

const service = "netsuite";

export const executors: ProviderExecutors = defineProviderExecutors<NetsuiteContext>({
  service,
  handlers: netsuiteActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<NetsuiteContext> {
    const credential = await requireCustomCredential(context, service);
    return resolveNetsuiteCredentialContext(credential.values, credential.metadata, fetcher, context.signal);
  },
  fallbackMessage: "netsuite request failed",
});

export const proxy: ProviderProxyExecutor = async (input, context) => {
  try {
    if (input.method !== "GET") {
      throw new ProviderRequestError(403, "NetSuite proxy is read-only");
    }
    if (!isAllowedNetsuiteReadEndpoint(input.endpoint)) {
      throw new ProviderRequestError(403, "NetSuite proxy endpoint is outside the read-only allowlist");
    }
    assertNetsuiteProxyQuery(input.query);
    const credential = await requireCustomCredential(context, service);
    if (optionalString(credential.values.companyId)) {
      throw new ProviderRequestError(403, "NetSuite proxy is disabled for company-scoped connections");
    }
    const netsuiteContext = resolveNetsuiteCredentialContext(
      credential.values,
      credential.metadata,
      providerFetch,
      context.signal,
    );
    const url = createProviderProxyUrl(netsuiteContext.restBaseUrl, input.endpoint, input.query);
    const headers = normalizeProviderProxyHeaders(input.headers);
    headers.set("accept", "application/json");
    headers.set("user-agent", providerUserAgent);

    const init: RequestInit = {
      method: input.method,
      headers,
      signal: context.signal,
    };
    if (input.body !== undefined) {
      init.body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
      if (!headers.has("content-type") && typeof input.body !== "string") {
        headers.set("content-type", "application/json");
      }
    }
    headers.set(
      "authorization",
      buildOAuthAuthorizationHeader({
        credential: netsuiteContext,
        method: input.method,
        url,
      }),
    );

    return await withErpConcurrency(async () => {
      const timeout = createProviderTimeout(context.signal, erpRequestTimeoutMs);
      try {
        const response = await providerFetch(url, { ...init, signal: timeout.signal, redirect: "manual" });
        if (response.status >= 300 && response.status < 400) {
          throw new ProviderRequestError(502, "NetSuite redirects are disabled");
        }
        if (!response.ok) {
          await readProviderProxyErrorMessage(response, "");
          throw new ProviderRequestError(response.status, `NetSuite request failed with HTTP ${response.status}`);
        }
        return {
          ok: true,
          response: await readProviderProxyResponse(response, { maxBytes: erpMaxResponseBytes }),
        };
      } catch (error) {
        if (error instanceof ProviderRequestError) throw error;
        throw new ProviderRequestError(timeout.didTimeout() ? 504 : 502, "NetSuite proxy request failed");
      } finally {
        timeout.cleanup();
      }
    });
  } catch (error) {
    return toProviderProxyError(error, "netsuite request failed");
  }
};

export const credentialValidators: CredentialValidators = {
  customCredential(input, { fetcher, signal }) {
    return validateNetsuiteCredential(input.values, fetcher, signal);
  },
};

export async function discoverResources(
  context: ExecutionContext,
  fetcher: typeof fetch,
): Promise<ProviderResourceCandidate[]> {
  const credential = await requireCustomCredential(context, service);
  const netsuiteContext = resolveNetsuiteCredentialContext(
    credential.values,
    credential.metadata,
    fetcher,
    context.signal,
  );
  const result = await netsuiteActionHandlers.discover_capabilities({}, netsuiteContext);
  const available = (result as { capabilities: Array<{ domain: string }> }).capabilities;
  const domains = new Set(available.map((capability) => capability.domain));
  return discoverErpCapabilities(netsuiteEntities)
    .filter((capability) => domains.has(capability.domain))
    .map((capability) => ({
      sourceType: "netsuite",
      resourceId: capability.domain,
      title: `NetSuite: ${capability.domain}`,
      mimeType: `application/vnd.oomol.erp.${capability.domain}`,
      schema: { ...capability },
    }));
}

function isAllowedNetsuiteReadEndpoint(endpoint: string): boolean {
  if (endpoint === "/services/rest/record/v1/metadata-catalog") return true;
  return netsuiteEntities.some((entity) => {
    const root = `/services/rest/record/v1/${encodeURIComponent(entity.entity)}`;
    return endpoint === root || endpoint.startsWith(`${root}/`);
  });
}

function assertNetsuiteProxyQuery(query: Record<string, unknown> | undefined): void {
  const limit = query?.limit;
  const normalizedLimit = limit === undefined ? 100 : Number(limit);
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 200) {
    throw new ProviderRequestError(400, "limit must be between 1 and 200");
  }
  const offset = query?.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > normalizedLimit * (erpMaxPages - 1)) {
    throw new ProviderRequestError(400, `offset must stay within ${erpMaxPages} pages`);
  }
}
