"""commands.run_command: confinement, output tails, timeout."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from localpilot_jupyter.commands import COMMAND_TIMEOUT_S, OUTPUT_TAIL_CHARS, run_command


async def test_runs_in_confined_cwd_and_reports_exit_code(tmp_path: Path) -> None:
    root = tmp_path / "root"
    sub = root / "pkg"
    sub.mkdir(parents=True)
    res = await run_command({"command": "pwd; echo oops >&2; exit 3", "cwd": str(sub)}, root)
    assert res["exitCode"] == 3
    assert Path(res["stdout"].strip()).resolve() == sub.resolve()
    assert res["stderr"] == "oops\n"


async def test_relative_and_missing_cwd_resolve_inside_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    (root / "pkg").mkdir(parents=True)
    rel = await run_command({"command": "pwd", "cwd": "pkg"}, root)
    assert Path(rel["stdout"].strip()).resolve() == (root / "pkg").resolve()
    none = await run_command({"command": "pwd"}, root)
    assert Path(none["stdout"].strip()).resolve() == root.resolve()


async def test_cwd_outside_root_is_refused_without_running(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    marker = tmp_path / "ran"
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (root / "link").symlink_to(outside)
    for cwd in [str(outside), "../elsewhere", str(root / "link"), "/"]:
        res = await run_command({"command": f"touch {marker}", "cwd": cwd}, root)
        assert res["exitCode"] == -1, cwd
        assert "outside" in res["stderr"], cwd
    assert not marker.exists()


async def test_nonexistent_cwd_is_reported(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    res = await run_command({"command": "true", "cwd": "nope"}, root)
    assert res["exitCode"] == -1
    assert "nope" in res["stderr"]


async def test_outputs_are_tails(tmp_path: Path) -> None:
    script = "import sys; sys.stdout.write('a' * 40000 + 'END'); sys.stderr.write('b' * 40000 + 'ERR')"
    res = await run_command({"command": f'python3 -c "{script}"'}, tmp_path)
    assert res["exitCode"] == 0
    assert res["stdout"].endswith("a" * 100 + "END")
    assert res["stderr"].endswith("b" * 100 + "ERR")
    assert "truncated" in res["stdout"]
    for stream in ("stdout", "stderr"):
        assert OUTPUT_TAIL_CHARS < len(res[stream]) <= OUTPUT_TAIL_CHARS + 100


async def test_timeout_kills_the_process_group(tmp_path: Path) -> None:
    pidfile = tmp_path / "child.pid"
    loop = asyncio.get_running_loop()
    started = loop.time()
    # The shell backgrounds a grandchild that would outlive a plain kill of the shell.
    res = await run_command({"command": f"sleep 30 & echo $! > {pidfile}; wait"}, tmp_path, timeout_s=0.5)
    assert loop.time() - started < 10
    assert res["exitCode"] == -1
    assert "timed out" in res["stderr"]
    pid = int(pidfile.read_text())

    def gone() -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        return False

    from .conftest import eventually

    await eventually(gone, what="grandchild killed")


def test_default_timeout_is_shorter_than_the_cores_request_timeout() -> None:
    # The core gives up on a client request after 10 minutes (CLIENT_REQUEST_TIMEOUT);
    # the command is killed and reported first, as in VS Code.
    assert COMMAND_TIMEOUT_S == 9 * 60
