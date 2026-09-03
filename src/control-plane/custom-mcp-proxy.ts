import type { CustomMcpResourceRecord } from "./custom-mcp-resource-store.ts";
import type { Context } from "hono";

import { createGuardedFetch } from "../core/guarded-fetch.ts";

const maxRequestBytes = 4 * 1024 * 1024;
const maxResponseBytes = 16 * 1024 * 1024;
const defaultTimeoutMs = 60_000;

export interface CustomMcpProxyOptions {
  fetcher?: typeof fetch;
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
  skipDnsValidation?: boolean;
}

/**
 * HTTP-level MCP proxy. It intentionally does not create a new MCP server:
 * session IDs, SSE events, protocol-version headers and JSON-RPC envelopes
 * must retain their upstream semantics.
 */
export async function proxyCustomMcp(
  context: Context,
  resource: CustomMcpResourceRecord,
  options: CustomMcpProxyOptions = {},
): Promise<Response> {
  const request = context.req.raw;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("MCP upstream request timed out.")),
    options.timeoutMs ?? defaultTimeoutMs,
  );
  const signal = AbortSignal.any([request.signal, controller.signal]);
  try {
    const body = await readBody(request);
    const headers = forwardedHeaders(request.headers, resource);
    const fetcher = createGuardedFetch({
      fetch: options.fetcher,
      allowPrivateNetwork: options.allowPrivateNetwork === true,
      additionalSensitiveHeaders: ["x-ve-tip-token", "x-arkclaw-jwt"],
      skipDnsValidation: options.skipDnsValidation === true,
    });
    const upstream = await fetcher(resource.upstreamUrl, {
      method: request.method,
      headers,
      body: body ?? undefined,
      redirect: "error",
      signal,
    });
    const responseHeaders = new Headers();
    for (const name of [
      "content-type",
      "cache-control",
      "content-encoding",
      "content-language",
      "content-location",
      "etag",
      "last-event-id",
      "mcp-session-id",
      "retry-after",
    ]) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    if (isStreamingResponse(upstream)) {
      return new Response(limitStream(upstream.body), { status: upstream.status, headers: responseHeaders });
    }
    const responseBody = await readResponse(upstream);
    return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    if (error instanceof BodyLimitError) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: error.message }, id: null }),
        {
          status: 413,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "MCP upstream request timed out." },
          id: null,
        }),
        {
          status: 504,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "MCP upstream request failed." }, id: null }),
      {
        status: 502,
        headers: { "content-type": "application/json" },
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}

function isStreamingResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
}

function forwardedHeaders(input: Headers, resource: CustomMcpResourceRecord): Headers {
  const output = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "content-encoding",
    "content-language",
    "content-location",
    "last-event-id",
    "mcp-protocol-version",
    "mcp-session-id",
    "origin",
    "user-agent",
  ]) {
    const value = input.get(name);
    if (value !== null) output.set(name, value);
  }
  if (resource.forwardAuthorization) {
    const authorization = input.get("authorization");
    if (authorization) output.set("authorization", authorization);
  }
  if (resource.forwardTipToken) {
    const tip = input.get("x-ve-tip-token") ?? input.get("x-arkclaw-jwt");
    if (tip) output.set("x-ve-tip-token", tip);
  }
  return output;
}

async function readBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (["GET", "HEAD", "DELETE"].includes(request.method.toUpperCase())) return undefined;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes)
    throw new BodyLimitError("MCP request body is too large.");
  const body = await request.arrayBuffer();
  if (body.byteLength > maxRequestBytes) throw new BodyLimitError("MCP request body is too large.");
  return body;
}

async function readResponse(response: Response): Promise<ArrayBuffer | null> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes)
    throw new BodyLimitError("MCP response body is too large.");
  const body = await response.arrayBuffer();
  if (body.byteLength > maxResponseBytes) throw new BodyLimitError("MCP response body is too large.");
  return body;
}

function limitStream(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (!body) return body;
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxResponseBytes) {
          controller.error(new BodyLimitError("MCP response body is too large."));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

class BodyLimitError extends Error {}
