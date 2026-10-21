"""CoreProcess against the real fake-core subprocess."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from localpilot_jupyter.core_process import CoreCrashed, CoreNotRunning, CoreProcess

from .conftest import TIMEOUT, eventually


def make_core(binary: Path, workspace: Path, **env: str) -> CoreProcess:
    return CoreProcess(binary, workspace, "info", env={**os.environ, **env}, shutdown_timeout=0.5)


async def test_core_process_starts_and_answers_initialize(fake_core_binary: Path, workspace: Path) -> None:
    core = make_core(fake_core_binary, workspace, FAKE_INDEX_FIRST="1")
    lines: list[dict] = []
    remove = core.add_listener(lambda line: lines.append(json.loads(line)))
    assert core.state == "stopped"
    try:
        result = await asyncio.wait_for(core.start({"completionsEnabled": True}), TIMEOUT)
        assert core.state == "ready"
        assert core.settings == {"completionsEnabled": True}
        assert result["capabilities"]["chat"] is True
        assert core.initialize_result is not None
        # index/ready raced ahead of the initialize response; the cached result still reflects it.
        assert core.initialize_result["indexStatus"] == "ready"
        # The server's own initialize response is never handed to listeners...
        assert not any("result" in m for m in lines)
        # ...but notifications are (index/ready before the response included).
        assert any(m.get("method") == "index/ready" for m in lines)
        await eventually(lambda: core.ollama_status, what="status notification")
        assert core.ollama_status == {"ollama": "ok", "detail": "Ollama is running"}

        # A second start() while ready returns the cached result without a new process.
        again = await core.start({"other": 1})
        assert again == core.initialize_result
        assert core.launches == 1

        core.send_line(json.dumps({"jsonrpc": "2.0", "id": "t1:7", "method": "ollama/status"}))
        reply = await eventually(lambda: next((m for m in lines if m.get("id") == "t1:7"), None))
        assert reply["result"]["ollama"] == "ok"
    finally:
        await core.stop()
        remove()
    assert core.state == "stopped"
    with pytest.raises(CoreNotRunning):
        core.send_line("{}")


async def test_crash_restarts_then_gives_up_after_3(fake_core_binary: Path, workspace: Path) -> None:
    # The fake exits on its first request (initialize) every time it is launched.
    core = make_core(fake_core_binary, workspace, FAKE_CRASH_AFTER="1")
    states: list[str] = []
    core.add_state_listener(states.append)
    with pytest.raises(CoreCrashed):
        await asyncio.wait_for(core.start({}), TIMEOUT)
    assert core.state == "crashed"
    assert core.launches == 4  # first launch + 3 restarts within the minute
    assert states[-1] == "crashed"
    with pytest.raises(CoreNotRunning):
        core.send_line("{}")
    await core.stop()


async def test_crash_after_ready_restarts_and_reinitializes(fake_core_binary: Path, workspace: Path) -> None:
    # initialize is request #1; the next request kills the process.
    core = make_core(fake_core_binary, workspace, FAKE_CRASH_AFTER="2")
    exits: list[bool] = []
    core.add_exit_listener(exits.append)
    try:
        await asyncio.wait_for(core.start({"model": "x"}), TIMEOUT)
        core.send_line(json.dumps({"jsonrpc": "2.0", "id": "t1:1", "method": "ollama/status"}))
        await eventually(lambda: core.launches == 2 and core.state == "ready", what="restart")
        assert exits == [True]  # one exit, and that generation had been ready
        assert core.settings == {"model": "x"}  # restarted with the stored settings
    finally:
        await core.stop()


async def test_partial_and_large_lines_are_reassembled(fake_core_binary: Path, workspace: Path) -> None:
    core = make_core(fake_core_binary, workspace)
    lines: list[dict] = []
    core.add_listener(lambda line: lines.append(json.loads(line)))
    try:
        await asyncio.wait_for(core.start({}), TIMEOUT)
        big = "x" * 300_000  # far over asyncio's default 64 KiB line limit
        core.send_line(json.dumps({"jsonrpc": "2.0", "id": "t1:9", "method": "ollama/pull", "params": {"model": big}}))
        reply = await eventually(lambda: next((m for m in lines if m.get("id") == "t1:9"), None))
        assert reply["result"] == {}
        progress = [m for m in lines if m.get("method") == "ollama/pullProgress"]
        assert progress and progress[0]["params"]["model"] == big
    finally:
        await core.stop()


async def test_spawn_failure_is_crashed_without_retry(tmp_path: Path, workspace: Path) -> None:
    core = make_core(tmp_path / "does-not-exist", workspace)
    with pytest.raises(CoreCrashed):
        await core.start({})
    assert core.state == "crashed"
    assert core.launches == 1


async def test_stop_kills_a_core_that_ignores_shutdown(fake_core_binary: Path, workspace: Path) -> None:
    core = make_core(fake_core_binary, workspace, FAKE_IGNORE_SHUTDOWN="1")
    await asyncio.wait_for(core.start({}), TIMEOUT)
    await asyncio.wait_for(core.stop(), TIMEOUT)
    assert core.state == "stopped"
    assert core.launches == 1  # an intentional stop is not a crash


async def test_restart_uses_new_settings(fake_core_binary: Path, workspace: Path) -> None:
    core = make_core(fake_core_binary, workspace)
    try:
        await asyncio.wait_for(core.start({"a": 1}), TIMEOUT)
        await asyncio.wait_for(core.restart({"a": 2}), TIMEOUT)
        assert core.state == "ready"
        assert core.settings == {"a": 2}
        assert core.launches == 2
    finally:
        await core.stop()
