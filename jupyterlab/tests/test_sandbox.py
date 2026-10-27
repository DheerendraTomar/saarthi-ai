"""sandbox: argv building, the start-Ollama line, and the fail-closed decision."""

from __future__ import annotations

import shlex
from pathlib import Path

import pytest

from localpilot_jupyter import sandbox
from localpilot_jupyter.commands import run_command
from localpilot_jupyter.sandbox import (
    SANDBOX_EXEC,
    SandboxUnavailable,
    check_sandbox,
    command_argv,
    ollama_start_command,
)

PROFILE = Path("/pkg/sandbox/no-network.sb")


def yes(_: str) -> bool:
    return True


def test_argv_is_a_list_with_the_command_as_one_item() -> None:
    cmd = "echo 'a b'; rm -rf $HOME && curl x"
    argv = command_argv(cmd, "darwin", PROFILE, SANDBOX_EXEC, yes)
    assert argv == ["/usr/bin/sandbox-exec", "-f", str(PROFILE), "/bin/sh", "-c", cmd]


@pytest.mark.parametrize("platform", ["linux", "win32"])
def test_non_macos_fails_closed(platform: str) -> None:
    with pytest.raises(SandboxUnavailable, match="macOS"):
        command_argv("ls", platform, PROFILE, SANDBOX_EXEC, yes)


def test_missing_sandbox_exec_or_profile_fails_closed() -> None:
    with pytest.raises(SandboxUnavailable, match="sandbox-exec"):
        check_sandbox("darwin", PROFILE, SANDBOX_EXEC, lambda p: p != SANDBOX_EXEC)
    with pytest.raises(SandboxUnavailable, match="profile"):
        check_sandbox("darwin", PROFILE, SANDBOX_EXEC, lambda p: p != str(PROFILE))


async def test_run_command_does_not_run_when_the_sandbox_is_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    marker = tmp_path / "ran"
    monkeypatch.setattr(sandbox.sys, "platform", "linux")
    res = await run_command({"command": f"touch {marker}"}, tmp_path)
    assert res["exitCode"] != 0
    assert res["stdout"] == ""
    assert res["stderr"].startswith("LocalPilot runs commands only inside a no-network sandbox (macOS). Not run: ")
    assert f"touch {marker}" in res["stderr"]
    assert not marker.exists()


def test_start_ollama_restarts_the_launch_agent_when_installed(tmp_path: Path) -> None:
    agents = tmp_path / "Library" / "LaunchAgents"
    agents.mkdir(parents=True)
    plist = agents / "local.ollama.sandboxed.plist"
    plist.write_text("<plist/>")
    cmd = ollama_start_command("darwin", PROFILE, SANDBOX_EXEC, tmp_path)
    assert cmd == (
        f"launchctl bootstrap gui/$(id -u) {plist} 2>/dev/null "
        "|| launchctl kickstart gui/$(id -u)/local.ollama.sandboxed"
    )


def test_start_ollama_without_agent_runs_sandbox_exec_with_quoting(tmp_path: Path) -> None:
    profile = Path("/Users/me/my env/it's/no-network.sb")
    cmd = ollama_start_command("darwin", profile, SANDBOX_EXEC, tmp_path, lambda p: "LaunchAgents" not in p)
    assert cmd.startswith("OLLAMA_NO_CLOUD=1 OLLAMA_HOST=127.0.0.1:11434 exec /usr/bin/sandbox-exec -f ")
    assert cmd.endswith(" ollama serve")
    assert shlex.split(cmd)[-4:] == ["-f", str(profile), "ollama", "serve"]


def test_start_ollama_refuses_off_macos_and_without_profile(tmp_path: Path) -> None:
    with pytest.raises(SandboxUnavailable) as err:
        ollama_start_command("linux", PROFILE, SANDBOX_EXEC, tmp_path, yes)
    assert "needs macOS" in str(err.value) and "OLLAMA_NO_CLOUD=1" in str(err.value)
    with pytest.raises(SandboxUnavailable, match="profile"):
        ollama_start_command("darwin", PROFILE, SANDBOX_EXEC, tmp_path, lambda p: p != str(PROFILE) and "LaunchAgents" not in p)


def test_bundled_profile_is_the_no_network_one() -> None:
    assert sandbox.PROFILE.is_file()
    assert "(deny network*)" in sandbox.PROFILE.read_text()
