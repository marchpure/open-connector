import type { LeaseRuntimeMcpContext } from "./runtime-mcp.ts";
import type { ControlPlaneDependencies } from "./service.ts";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";

import { parseJSONRPCMessage } from "@modelcontextprotocol/server";
import { assertLeaseRuntimeRequest, createLeaseRuntimeMcpServer } from "./runtime-mcp.ts";

const sessionCheckIntervalMs = 100;
const maxRequestBytes = 1024 * 1024;

interface RuntimeMcpSseSession {
  lease: LeaseRuntimeMcpContext;
  server: ReturnType<typeof createLeaseRuntimeMcpServer>;
  transport: RuntimeMcpSseTransport;
  leaseWatch: ReturnType<typeof setInterval>;
}

export class RuntimeMcpSseSessions {
  private readonly deps: ControlPlaneDependencies;
  private readonly sessions = new Map<string, RuntimeMcpSseSession>();

  constructor(deps: ControlPlaneDependencies) {
    this.deps = deps;
  }

  async open(lease: LeaseRuntimeMcpContext, request: Request): Promise<Response> {
    assertLeaseRuntimeRequest(this.deps, lease);
    const sessionId = crypto.randomUUID();
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel: () => this.close(sessionId),
    });
    const transport = new RuntimeMcpSseTransport(sessionId, streamController!);
    const server = createLeaseRuntimeMcpServer(this.deps, lease, transport.signal);
    await server.connect(transport);
    const leaseWatch = setInterval(() => {
      try {
        assertLeaseRuntimeRequest(this.deps, lease);
      } catch {
        void this.close(sessionId);
      }
    }, sessionCheckIntervalMs);
    this.sessions.set(sessionId, { lease, server, transport, leaseWatch });
    request.signal.addEventListener("abort", () => void this.close(sessionId), { once: true });
    const messageEndpoint = new URL(request.url);
    messageEndpoint.searchParams.set("sessionId", sessionId);
    await transport.sendEndpoint(`${messageEndpoint.pathname}${messageEndpoint.search}`);
    return new Response(stream, {
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      },
    });
  }

  async receive(sessionId: string | undefined, lease: LeaseRuntimeMcpContext, request: Request): Promise<Response> {
    if (!sessionId) return new Response("Missing MCP session id.", { status: 400 });
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.lease.token !== lease.token ||
      session.lease.connectionId !== lease.connectionId ||
      session.lease.invocationId !== lease.invocationId ||
      session.lease.audience !== lease.audience
    ) {
      return new Response("MCP session was not found.", { status: 404 });
    }
    assertLeaseRuntimeRequest(this.deps, lease);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > maxRequestBytes) return new Response("MCP request is too large.", { status: 413 });
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maxRequestBytes) {
      return new Response("MCP request is too large.", { status: 413 });
    }
    try {
      await session.transport.receive(parseJSONRPCMessage(JSON.parse(body)));
      return new Response(null, { status: 202 });
    } catch {
      return new Response("Invalid MCP JSON-RPC message.", { status: 400 });
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.close(sessionId)));
  }

  private async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearInterval(session.leaseWatch);
    await session.server.close().catch(() => undefined);
  }
}

class RuntimeMcpSseTransport implements Transport {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly controller: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private readonly abortController = new AbortController();
  private started = false;
  private closed = false;

  constructor(sessionId: string, controller: ReadableStreamDefaultController<Uint8Array>) {
    this.sessionId = sessionId;
    this.controller = controller;
    this.signal = this.abortController.signal;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("MCP SSE transport is already started.");
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.enqueue("message", JSON.stringify(message));
  }

  async sendEndpoint(endpoint: string): Promise<void> {
    this.enqueue("endpoint", endpoint);
  }

  async receive(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("MCP SSE transport is closed.");
    this.onmessage?.(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    try {
      this.controller.close();
    } catch {
      // The client may already have cancelled the stream.
    }
    this.onclose?.();
  }

  private enqueue(event: string, data: string): void {
    if (this.closed) throw new Error("MCP SSE transport is closed.");
    try {
      this.controller.enqueue(this.encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error("MCP SSE write failed."));
      void this.close();
      throw error;
    }
  }
}
