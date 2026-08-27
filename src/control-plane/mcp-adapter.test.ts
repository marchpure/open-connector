import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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
});
