"""Exercise the Oracle runtime MCP action through AutoSkill's MCP manager."""

from __future__ import annotations

import json
import os
import tempfile

import yaml

from src.mcp.mcp_manager import McpManager


def main() -> None:
    url = required_env("ORACLE_MCP_RUNTIME_URL")
    lease = required_env("ORACLE_MCP_LEASE")
    config = {
        "servers": {
            "oracle-connection": {
                "transport": "http",
                "url": url,
                "headers": {"X-Connection-Lease": lease},
            }
        },
        "knowledge_adapter_resources": [],
    }
    with tempfile.TemporaryDirectory(prefix="autoskill-oracle-mcp-") as directory:
        config_path = os.path.join(directory, "mcp_config.yaml")
        with open(config_path, "w", encoding="utf-8") as output:
            yaml.safe_dump(config, output)
        manager = McpManager(agent_folder=directory, config_path=config_path)
        try:
            manager.start()
            tools = sorted(tool["name"] for tool in manager.get_tool_definitions())
            expected = [
                "mcp__oracle-connection__execute_action",
                "mcp__oracle-connection__get_action_guide",
                "mcp__oracle-connection__list_allowed_actions",
            ]
            if tools != expected:
                raise RuntimeError(f"Unexpected AutoSkill MCP tools: {tools}")
            result = manager.call_tool(
                "mcp__oracle-connection__execute_action",
                {
                    "actionId": "oracle_database.execute_read_query",
                    "input": {
                        "query": 'select * from "STEP3B"."STEP3B_ORDERS" where "ORDER_ID" = :p1',
                        "parameters": ["O-2"],
                        "maxRows": 10,
                    },
                },
            )
            payload = json.loads(result)
            if not payload.get("ok") or not payload.get("auditPersisted"):
                raise RuntimeError(f"AutoSkill Oracle MCP action failed: {result}")
            print(json.dumps({"status": "passed", "client": "AutoSkill McpManager", "tools": tools, "auditPersisted": True}))
        finally:
            manager.stop()


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


if __name__ == "__main__":
    main()
