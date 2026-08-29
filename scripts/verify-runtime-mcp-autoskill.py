"""Exercise Connection Service through AutoSkill's production MCP manager."""

from __future__ import annotations

import json
import os
import tempfile

import yaml

from src.mcp.mcp_manager import McpManager


def main() -> None:
    url = required_env("CONNECTION_RUNTIME_MCP_URL")
    lease = required_env("CONNECTION_RUNTIME_MCP_LEASE")
    config = {
        "servers": {
            "knowledge-connection-1": {
                "transport": "http",
                "url": url,
                "headers": {
                    "X-Connection-Lease": lease,
                },
            }
        },
        "knowledge_adapter_resources": [],
    }

    with tempfile.TemporaryDirectory(prefix="autoskill-runtime-mcp-") as directory:
        config_path = os.path.join(directory, "mcp_config.yaml")
        with open(config_path, "w", encoding="utf-8") as output:
            yaml.safe_dump(config, output)
        manager = McpManager(agent_folder=directory, config_path=config_path)
        try:
            manager.start()
            tools = sorted(tool["name"] for tool in manager.get_tool_definitions())
            expected_tools = [
                "mcp__knowledge-connection-1__execute_action",
                "mcp__knowledge-connection-1__get_action_guide",
                "mcp__knowledge-connection-1__list_allowed_actions",
            ]
            if tools != expected_tools:
                raise RuntimeError(f"Unexpected AutoSkill MCP tools: {tools}")
            result = manager.call_tool(
                "mcp__knowledge-connection-1__execute_action",
                {"actionId": "hackernews.get_max_item_id", "input": {}},
            )
            payload = json.loads(result)
            if not payload.get("ok") or not payload.get("auditPersisted"):
                raise RuntimeError(f"AutoSkill MCP action failed: {result}")
            print(
                json.dumps(
                    {
                        "status": "passed",
                        "client": "AutoSkill McpManager",
                        "protocolSteps": ["initialize", "tools/list", "tools/call"],
                        "tools": tools,
                        "actionId": "hackernews.get_max_item_id",
                        "auditPersisted": True,
                    }
                )
            )
        finally:
            manager.stop()


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


if __name__ == "__main__":
    main()
