import { describe, expect, it } from "vitest";
import { ControlledMcpAdapter, McpAdapterError } from "./mcp-adapter.ts";

describe("ControlledMcpAdapter", () => {
  it("requires allowlisted stdio commands and headers", () => {
    expect(() => new ControlledMcpAdapter({ transport: "stdio", command: "node", allowedCommands: ["python"] }))
      .toThrowError(new McpAdapterError("command_not_allowed", "stdio command is not in the allowlist."));
    expect(() => new ControlledMcpAdapter({
      transport: "streamable_http",
      endpoint: "https://mcp.example.com",
      headers: { authorization: "secret" },
      allowedHeaderNames: [],
    })).toThrowError(/not allowlisted/);
  });
});
