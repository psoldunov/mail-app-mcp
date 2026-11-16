import asyncio
import os
from pathlib import Path
import subprocess
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def test_real_stdio_rejects_forbidden_operations_and_keeps_serving(tmp_path):
    async def scenario():
        params = StdioServerParameters(command=sys.executable, args=["-m", "mail_app_mcp.server"],
                                       env={**os.environ, "HOME": str(tmp_path)})
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                tools = await client.list_tools()
                assert len(tools.tools) == 13
                refused = await client.call_tool("send", {})
                assert refused.isError
                invalid = await client.call_tool("read_message", {"ref": {"message_id": 1}})
                assert invalid.isError
                assert len((await client.list_tools()).tools) == 13

    asyncio.run(scenario())
    assert not (tmp_path / "Library").exists()


def test_cli_bad_configuration_exits_cleanly(tmp_path):
    config = tmp_path / "invalid.json"
    config.write_text('{"enable_send":true}')
    result = subprocess.run([sys.executable, "-m", "mail_app_mcp.server", "--config", str(config)],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 2
    assert "Cannot load mailbox policy" in result.stderr
    assert "Traceback" not in result.stderr
    assert result.stdout == ""
