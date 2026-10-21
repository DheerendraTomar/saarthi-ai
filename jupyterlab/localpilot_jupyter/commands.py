"""Server-side answer to the core's `workspace/runCommand` request.

The browser cannot run commands, so the server extension runs the (already
user-approved) command itself: `shell=True` in a directory confined to the
Jupyter server's root, the last 16 KB of each stream returned, killed with its
whole process group after the timeout. Never raises.
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
from pathlib import Path
from typing import Any, Optional

#: Characters of each stream returned to the core (the tail; the start is dropped).
OUTPUT_TAIL_CHARS = 16 * 1024
#: Hard limit before the command is killed: 9 minutes, shorter than the core's
#: 10-minute limit on client requests (CLIENT_REQUEST_TIMEOUT in core/src/rpc/server.rs),
#: so a hung command is killed and its output reported before the core gives up (as in VS Code).
COMMAND_TIMEOUT_S = 9 * 60
TRUNCATED = "[… output truncated; last 16 KB shown]\n"
_READ_CHUNK = 64 * 1024


class _Tail:
    """Keeps the last `limit` characters of a stream."""

    def __init__(self, limit: int = OUTPUT_TAIL_CHARS) -> None:
        self.limit = limit
        self.text = ""
        self.dropped = False

    def push(self, chunk: str) -> None:
        self.text += chunk
        if len(self.text) > 2 * self.limit:
            self._trim()

    def _trim(self) -> None:
        if len(self.text) > self.limit:
            self.text = self.text[-self.limit :]
            self.dropped = True

    def value(self) -> str:
        self._trim()
        return TRUNCATED + self.text if self.dropped else self.text


def _result(exit_code: int, stdout: str = "", stderr: str = "") -> dict[str, Any]:
    return {"exitCode": exit_code, "stdout": stdout, "stderr": stderr}


def confine_cwd(cwd: Optional[str], root_dir: Path) -> Path:
    """Resolves `cwd` (absolute, or relative to the root) and checks it stays inside the root.

    Symlinks are resolved on both sides, so a link pointing out of the root is refused.
    Raises ValueError when it escapes or is not a directory.
    """
    root = Path(os.path.realpath(root_dir))
    target = Path(os.path.realpath(root / cwd)) if cwd else root
    if os.path.commonpath([root, target]) != str(root):
        raise ValueError(f"cwd {cwd!r} is outside the Jupyter server root {root}")
    if not target.is_dir():
        raise ValueError(f"cwd {cwd!r} is not a directory")
    return target


def _kill_group(proc: asyncio.subprocess.Process) -> None:
    try:
        if sys.platform != "win32":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except (ProcessLookupError, PermissionError):
        pass


async def _drain(stream: Optional[asyncio.StreamReader], tail: _Tail) -> None:
    if stream is None:
        return
    while True:
        chunk = await stream.read(_READ_CHUNK)
        if not chunk:
            return
        tail.push(chunk.decode("utf-8", errors="replace"))


async def run_command(
    params: dict[str, Any], root_dir: Path, timeout_s: float = COMMAND_TIMEOUT_S
) -> dict[str, Any]:
    """Runs `params.command` in `params.cwd` (confined to `root_dir`); returns `{exitCode, stdout, stderr}`.

    `exitCode` is -1 when the command was refused, could not start, or timed out.
    """
    command = params.get("command") if isinstance(params, dict) else None
    if not isinstance(command, str) or not command.strip():
        return _result(-1, stderr="runCommand: missing command")
    cwd = params.get("cwd")
    try:
        directory = confine_cwd(cwd if isinstance(cwd, str) else None, root_dir)
    except ValueError as err:
        return _result(-1, stderr=f"refused: {err}")

    stdout, stderr = _Tail(), _Tail()
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=str(directory),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            # Own process group, so a timeout kills the command's children too.
            start_new_session=sys.platform != "win32",
        )
    except OSError as err:
        return _result(-1, stderr=f"failed to start in {directory}: {err}")

    readers = asyncio.gather(_drain(proc.stdout, stdout), _drain(proc.stderr, stderr), proc.wait())
    try:
        await asyncio.wait_for(asyncio.shield(readers), timeout_s)
    except asyncio.TimeoutError:
        _kill_group(proc)
        try:
            # Something may still hold the pipes open; do not wait for it forever.
            await asyncio.wait_for(readers, 2)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            readers.cancel()
        note = f"timed out after {timeout_s:g} s; killed"
        err_text = stderr.value()
        return _result(-1, stdout.value(), err_text + ("\n" if err_text and not err_text.endswith("\n") else "") + note)
    except asyncio.CancelledError:
        _kill_group(proc)
        readers.cancel()
        raise
    code = proc.returncode
    return _result(code if code is not None and code >= 0 else -1, stdout.value(), stderr.value())
