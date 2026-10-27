"""No-network sandbox helpers (macOS `sandbox-exec`): pure argv/command builders.

Both agent commands and "Start Ollama" run under `sandbox/no-network.sb`, which
allows everything except network access beyond this machine (loopback only).
If the sandbox cannot be used, nothing runs (fail closed).
"""

from __future__ import annotations

import os
import shlex
import sys
from pathlib import Path
from typing import Callable

_BUNDLED = Path(__file__).parent / "sandbox" / "no-network.sb"
_REPO = Path(__file__).resolve().parents[2] / "sandbox" / "no-network.sb"
#: The profile bundled in the package (copied in by scripts/package-jupyterlab.sh);
#: a source checkout falls back to the repo's sandbox/ copy.
PROFILE = _BUNDLED if _BUNDLED.is_file() or not _REPO.is_file() else _REPO
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
AGENT_LABEL = "local.ollama.sandboxed"
OLLAMA_ADDR = "127.0.0.1:11434"
NETWORK_NOTE = "(LocalPilot runs commands without network access)"


class SandboxUnavailable(RuntimeError):
    """The no-network sandbox cannot be used; the message says why."""


def check_sandbox(
    platform: str | None = None,
    profile: Path = PROFILE,
    sandbox_exec: str = SANDBOX_EXEC,
    exists: Callable[[str], bool] = os.path.exists,
) -> None:
    """Raises SandboxUnavailable unless macOS, `sandbox-exec` and the profile are all present."""
    if (platform or sys.platform) != "darwin":
        raise SandboxUnavailable("the no-network sandbox needs macOS")
    if not exists(sandbox_exec):
        raise SandboxUnavailable(f"{sandbox_exec} is missing")
    if not exists(str(profile)):
        raise SandboxUnavailable(f"the sandbox profile {profile} is missing")


def command_argv(
    command: str,
    platform: str | None = None,
    profile: Path = PROFILE,
    sandbox_exec: str = SANDBOX_EXEC,
    exists: Callable[[str], bool] = os.path.exists,
) -> list[str]:
    """argv that runs `command` with `/bin/sh -c` inside the sandbox. The command is one argv item."""
    check_sandbox(platform, profile, sandbox_exec, exists)
    return [sandbox_exec, "-f", str(profile), "/bin/sh", "-c", command]


def refusal_message(command: str, reason: str) -> str:
    return f"LocalPilot runs commands only inside a no-network sandbox (macOS). Not run: {command} ({reason})"


def ollama_start_command(
    platform: str | None = None,
    profile: Path = PROFILE,
    sandbox_exec: str = SANDBOX_EXEC,
    home: Path | None = None,
    exists: Callable[[str], bool] = os.path.exists,
) -> str:
    """The shell line that starts Ollama sandboxed. Raises SandboxUnavailable (message is user-facing)."""
    if (platform or sys.platform) != "darwin":
        raise SandboxUnavailable(
            "LocalPilot only starts Ollama inside a no-network sandbox, which needs macOS. "
            "Start Ollama yourself with OLLAMA_NO_CLOUD=1 (e.g. `OLLAMA_NO_CLOUD=1 ollama serve`)."
        )
    plist = (home or Path.home()) / "Library" / "LaunchAgents" / f"{AGENT_LABEL}.plist"
    if exists(str(plist)):
        return (
            f"launchctl bootstrap gui/$(id -u) {shlex.quote(str(plist))} 2>/dev/null "
            f"|| launchctl kickstart gui/$(id -u)/{AGENT_LABEL}"
        )
    check_sandbox(platform, profile, sandbox_exec, exists)
    return (
        f"OLLAMA_NO_CLOUD=1 OLLAMA_HOST={OLLAMA_ADDR} exec "
        f"{shlex.quote(sandbox_exec)} -f {shlex.quote(str(profile))} ollama serve"
    )
