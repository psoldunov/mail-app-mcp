import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "install-mcpm.sh"
REVISION = "0123456789abcdef" * 2 + "01234567"
SHELL = shutil.which("sh")


@pytest.fixture
def installer(tmp_path):
    commands = tmp_path / "commands"
    commands.mkdir()
    installed = tmp_path / "tool bin with spaces" / "mail-app-mcp"
    installed.parent.mkdir()
    installed.write_text("#!/bin/sh\nexit 0\n")
    installed.chmod(0o755)
    log = tmp_path / "calls.jsonl"
    stub = f"#!{sys.executable}\n" + '''
import json
import os
from pathlib import Path
import sys

name = Path(sys.argv[0]).name
if name == "uname":
    print(os.environ.get("FAKE_OS", "Darwin"))
    sys.exit(0)
with open(os.environ["CALL_LOG"], "a") as output:
    output.write(json.dumps([name, sys.argv[1:], os.environ.get("MCPM_FORCE")]) + "\\n")
if name == "uv":
    if sys.argv[1:] == ["tool", "dir", "--bin"]:
        print(os.environ["TOOL_BIN"])
    elif os.environ.get("FAIL_INSTALL"):
        sys.exit(7)
elif os.environ.get("FAIL_MCPM"):
    sys.exit(8)
'''
    for name in ("uname", "uv", "mcpm"):
        command = commands / name
        command.write_text(stub)
        command.chmod(0o755)
    environment = {
        **os.environ,
        "PATH": str(commands),
        "HOME": str(tmp_path / "home"),
        "CALL_LOG": str(log),
        "TOOL_BIN": str(installed.parent),
        "MCPM_FORCE": "true",
    }

    def invoke(*args, extra_env=None):
        result = subprocess.run(
            [SHELL, str(SCRIPT), *args],
            env=environment | (extra_env or {}),
            capture_output=True,
            text=True,
            timeout=10,
        )
        calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return result, calls

    return invoke, commands, installed


@pytest.mark.parametrize("revision", ["main", "abc123", "g" * 40, "a" * 41, "$(touch unsafe)"])
def test_invalid_revision_fails_before_install(installer, revision):
    invoke, _, _ = installer
    result, calls = invoke(revision)
    assert result.returncode != 0
    assert "40" in result.stderr
    assert calls == []


def test_installs_exact_commit_and_registers_absolute_path_with_spaces(installer):
    invoke, _, installed = installer
    result, calls = invoke(REVISION)
    assert result.returncode == 0, result.stderr
    assert calls == [
        ["uv", ["tool", "install", f"git+https://github.com/psoldunov/mail-app-mcp.git@{REVISION}"], "true"],
        ["uv", ["tool", "dir", "--bin"], "true"],
        ["mcpm", ["new", "mail-app", "--type", "stdio", "--command", str(installed)], "false"],
    ]


@pytest.mark.parametrize("args", [(), (REVISION, "extra")])
def test_requires_exactly_one_revision(installer, args):
    invoke, _, _ = installer
    result, calls = invoke(*args)
    assert result.returncode != 0
    assert "Usage:" in result.stderr
    assert calls == []


def test_linux_fails_before_install(installer):
    invoke, _, _ = installer
    result, calls = invoke(REVISION, extra_env={"FAKE_OS": "Linux"})
    assert result.returncode != 0
    assert "requires macOS" in result.stderr
    assert calls == []


@pytest.mark.parametrize("missing", ["uv", "mcpm"])
def test_missing_tools_fail_before_install(installer, missing):
    invoke, commands, _ = installer
    (commands / missing).unlink()
    result, calls = invoke(REVISION)
    assert result.returncode != 0
    assert f"Install {missing}" in result.stderr
    assert calls == []


def test_install_failure_does_not_register(installer):
    invoke, _, _ = installer
    result, calls = invoke(REVISION, extra_env={"FAIL_INSTALL": "1"})
    assert result.returncode != 0
    assert "could not install" in result.stderr
    assert len(calls) == 1
    assert calls[0][0] == "uv"


@pytest.mark.parametrize("mode", ["missing", "not_executable", "relative_path"])
def test_unusable_binary_is_not_registered(installer, mode):
    invoke, _, installed = installer
    if mode == "missing":
        installed.unlink()
    elif mode == "not_executable":
        installed.chmod(0o644)
    result, calls = invoke(REVISION, extra_env={"TOOL_BIN": "relative/path"} if mode == "relative_path" else {})
    assert result.returncode != 0
    assert "executable" in result.stderr
    assert [call[0] for call in calls] == ["uv", "uv"]


def test_registration_failure_is_reported_without_forcing(installer):
    invoke, _, _ = installer
    result, calls = invoke(REVISION, extra_env={"FAIL_MCPM": "1"})
    assert result.returncode != 0
    assert "MCPM registration failed" in result.stderr
    assert calls[-1][0] == "mcpm"
    assert calls[-1][2] == "false"
    assert "--force" not in calls[-1][1]
