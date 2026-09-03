import type { ProviderExecutors } from "../../core/types.ts";

import { optionalRecord, optionalString } from "../../core/cast.ts";
import {
  defineProviderExecutors,
  normalizeProviderProxyHeaders,
  providerFetch,
  providerUserAgent,
  ProviderRequestError,
  readProviderProxyResponse,
} from "../provider-runtime.ts";

const service = "web_action";
const blockedHeaders = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);

interface WebActionContext {
  signal?: AbortSignal;
}

export const executors: ProviderExecutors = defineProviderExecutors<WebActionContext>({
  service,
  handlers: {
    async fetch_json(input, context) {
      const url = optionalString(input.url);
      if (!url) {
        throw new ProviderRequestError(400, "url is required.");
      }
      const method = (optionalString(input.method) ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        throw new ProviderRequestError(400, "method must be GET or HEAD.");
      }
      const headerInput = optionalRecord(input.headers);
      for (const name of Object.keys(headerInput ?? {})) {
        if (blockedHeaders.has(name.toLowerCase())) {
          throw new ProviderRequestError(400, `${name.toLowerCase()} header is not allowed.`);
        }
      }
      const headers = normalizeProviderProxyHeaders(headerInput);
      if (!headers.has("accept")) headers.set("accept", "application/json");
      if (!headers.has("user-agent")) headers.set("user-agent", providerUserAgent);

      const response = await providerFetch(url, { method, headers, signal: context.signal });
      if (!response.ok) {
        throw new ProviderRequestError(response.status, `web request failed with HTTP ${response.status}`);
      }
      const result = await readProviderProxyResponse(response, { maxBytes: 1024 * 1024 });
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("json")) {
        throw new ProviderRequestError(400, "response content-type must be JSON.");
      }
      return {
        status: result.status,
        headers: result.headers,
        data: optionalRecord(result.data) ?? result.data,
      };
    },
  },
  createContext(context) {
    return { signal: context.signal };
  },
});
