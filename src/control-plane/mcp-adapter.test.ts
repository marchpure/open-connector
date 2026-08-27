import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AesGcmSecretCodec } from "../server/secrets/secret-codec.ts";
import { ControlledMcpAdapter, McpAdapterError, TenantMcpDefinitionStore } from "./mcp-adapter.ts";

describe("ControlledMcpAdapter", () => {
  it("requires allowlisted stdio commands and headers", () => {
    expect(
      () => new ControlledMcpAdapter({ transport: "stdio", command: "node", allowedCommands: ["python"] }),
    ).toThrowError(new McpAdapterError("command_not_allowed", "stdio command is not in the allowlist."));
    expect(
      () =>
        new ControlledMcpAdapter({
          transport: "streamable_http",
          endpoint: "https://mcp.example.com",
          headers: { authorization: "secret" },
          allowedHeaderNames: [],
        }),
    ).toThrowError(/not allowlisted/);
  });

  it("rejects calls outside the configured tool allowlist before connecting", async () => {
    const adapter = new ControlledMcpAdapter({
      transport: "stdio",
      command: "node",
      allowedCommands: ["node"],
      allowedTools: ["safe.read"],
    });
    await expect(adapter.callTool("admin.delete", {})).rejects.toMatchObject({ code: "tool_not_allowed" });
  });

  it("rejects unsafe tool schemas returned during discovery", async () => {
    const adapter = new ControlledMcpAdapter(
      {
        transport: "stdio",
        command: "node",
        allowedCommands: ["node"],
        allowedTools: ["unsafe"],
      },
      async (run) =>
        run({
          listTools: async () => ({
            tools: [{ name: "unsafe", inputSchema: { type: "string" } }],
          }),
          listResources: async () => ({ resources: [] }),
          listPrompts: async () => ({ prompts: [] }),
        } as never),
    );
    await expect(adapter.discover()).rejects.toMatchObject({ code: "invalid_schema" });
  });

  it("persists encrypted MCP definitions with tenant isolation", async () => {
    const database = new DatabaseSync(":memory:");
    const codec = new AesGcmSecretCodec("mcp-definition-key");
    const tenantA = new TenantMcpDefinitionStore(database, { tenantId: "tenant-a", workspaceId: "workspace-a" }, codec);
    const stored = await tenantA.save({
      transport: "streamable_http",
      endpoint: "https://mcp.example.com",
      headers: { authorization: "Bearer secret" },
      allowedHeaderNames: ["authorization"],
      allowedTools: ["safe.read"],
    });

    expect(await tenantA.get(stored.id)).toMatchObject({
      transport: "streamable_http",
      headers: { authorization: "Bearer secret" },
      allowedTools: ["safe.read"],
    });
    expect(JSON.stringify(database.prepare("select * from tenant_mcp_definitions").all())).not.toContain(
      "Bearer secret",
    );
    const tenantB = new TenantMcpDefinitionStore(database, { tenantId: "tenant-b", workspaceId: "workspace-b" }, codec);
    await expect(tenantB.get(stored.id)).resolves.toBeUndefined();
    database.close();
  });

  it("bounds MCP operations with a configured timeout", async () => {
    const adapter = new ControlledMcpAdapter(
      {
        transport: "stdio",
        command: "node",
        allowedCommands: ["node"],
        timeoutMs: 10,
      },
      async () => new Promise(() => undefined),
    );
    await expect(adapter.discover()).rejects.toMatchObject({
      code: "request_failed",
      message: "MCP request timed out.",
    });
  });

  it("discovers and calls a real local Streamable HTTP server when private-network access is explicit", async () => {
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: "fixture-http", version: "1.0.0" });
        server.registerTool(
          "echo",
          { description: "Echo input.", inputSchema: z.object({ value: z.string() }) },
          async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
        );
        server.registerResource("status", "fixture://status", { title: "Status" }, async (uri) => ({
          contents: [{ uri: uri.href, text: "ready" }],
        }));
        server.registerPrompt("summarize", { description: "Summarize fixture data." }, async () => ({
          messages: [{ role: "user", content: { type: "text", text: "Summarize." } }],
        }));
        return server;
      },
      { responseMode: "sse" },
    );
    const app = new Hono().all("/mcp", (context) => handler.fetch(context.req.raw));
    const httpServer = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 0 });
    const port = await new Promise<number>((resolve) =>
      httpServer.on("listening", () => resolve((httpServer.address() as { port: number }).port)),
    );
    const privateHost = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
    if (!privateHost) throw new Error("A private IPv4 interface is required for this integration test.");
    try {
      const adapter = new ControlledMcpAdapter({
        transport: "streamable_http",
        endpoint: `http://${privateHost}:${port}/mcp`,
        allowPrivateNetwork: true,
        allowedTools: ["echo"],
      });
      await expect(adapter.discover()).resolves.toMatchObject({
        tools: [{ name: "echo" }],
        resources: [{ uri: "fixture://status" }],
        prompts: [{ name: "summarize" }],
      });
      await expect(adapter.callTool("echo", { value: "http-e2e" })).resolves.toMatchObject({
        content: [{ type: "text", text: '{"value":"http-e2e"}' }],
      });
    } finally {
      httpServer.close();
      await handler.close();
    }
  });

  it("discovers and calls a real local legacy SSE server when private-network access is explicit", async () => {
    let sendEvent: ((message: unknown) => void) | undefined;
    const httpServer = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/sse") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(`event: endpoint\ndata: http://${request.headers.host}/messages\n\n`);
        sendEvent = (message) => response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
        return;
      }
      if (request.method === "POST" && request.url === "/messages") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const message = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
          response.writeHead(202).end();
          if (message.id === undefined) return;
          const result =
            message.method === "initialize"
              ? {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {}, resources: {}, prompts: {} },
                  serverInfo: { name: "fixture-sse", version: "1.0.0" },
                }
              : message.method === "tools/list"
                ? { tools: [{ name: "echo", description: "Echo input.", inputSchema: { type: "object" } }] }
                : message.method === "resources/list"
                  ? { resources: [{ uri: "fixture://status", name: "Status" }] }
                  : message.method === "prompts/list"
                    ? { prompts: [{ name: "summarize", description: "Summarize fixture data." }] }
                    : message.method === "tools/call"
                      ? { content: [{ type: "text", text: JSON.stringify(message.params?.arguments ?? {}) }] }
                      : {};
          sendEvent?.({ jsonrpc: "2.0", id: message.id, result });
        });
        return;
      }
      response.writeHead(404).end();
    });
    httpServer.listen(0, "0.0.0.0");
    const port = await new Promise<number>((resolve) =>
      httpServer.on("listening", () => resolve((httpServer.address() as { port: number }).port)),
    );
    const privateHost = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
    if (!privateHost) throw new Error("A private IPv4 interface is required for this integration test.");
    try {
      const adapter = new ControlledMcpAdapter({
        transport: "sse",
        endpoint: `http://${privateHost}:${port}/sse`,
        allowPrivateNetwork: true,
        allowedTools: ["echo"],
      });
      await expect(adapter.discover()).resolves.toMatchObject({
        tools: [{ name: "echo" }],
        resources: [{ uri: "fixture://status" }],
        prompts: [{ name: "summarize" }],
      });
      await expect(adapter.callTool("echo", { value: "sse-e2e" })).resolves.toMatchObject({
        content: [{ type: "text", text: '{"value":"sse-e2e"}' }],
      });
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
