"""Shared fixtures: the fake core (vscode/test/fakeCore.mjs run by node) and helpers.

The fake core is launched through a tiny `/bin/sh` wrapper written to `tmp_path`
(`exec node fakeCore.mjs "$@"`), so production code sees a single executable path
exactly like the real `localpilot-core` binary. Its `FAKE_*` options are passed
through the environment.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import stat
from pathlib import Path
from typing import Any, Callable

import pytest
from traitlets.config import Config

pytest_plugins = ["pytest_jupyter.jupyter_server"]

REPO_ROOT = Path(__file__).resolve().parents[2]
FAKE_CORE = REPO_ROOT / "vscode" / "test" / "fakeCore.mjs"
NODE = shutil.which("node") or "/Users/dst/.nvm/versions/node/v20.19.2/bin/node"

TIMEOUT = 15.0


@pytest.fixture
def fake_core_path() -> Path:
    assert FAKE_CORE.is_file(), f"missing {FAKE_CORE}"
    return FAKE_CORE


@pytest.fixture
def fake_core_binary(tmp_path: Path, fake_core_path: Path) -> Path:
    """An executable that runs the fake core with the arguments it is given."""
    wrapper = tmp_path / "bin" / "fake-localpilot-core"
    wrapper.parent.mkdir(parents=True, exist_ok=True)
    wrapper.write_text(f'#!/bin/sh\nexec "{NODE}" "{fake_core_path}" "$@"\n')
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return wrapper


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "workspace"
    ws.mkdir()
    return ws


@pytest.fixture
def jp_server_config(fake_core_binary: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    monkeypatch.delenv("LOCALPILOT_CORE_BINARY", raising=False)
    return Config(
        {
            "ServerApp": {"jpserver_extensions": {"localpilot_jupyter": True}},
            "LocalPilot": {"core_binary": str(fake_core_binary)},
        }
    )


async def eventually(predicate: Callable[[], Any], timeout: float = TIMEOUT, what: str = "condition") -> Any:
    """Polls `predicate` (yielding to the loop between checks) until it is truthy."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if loop.time() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.01)


class Tab:
    """A browser tab's WebSocket, with an inbox for messages read while waiting for others."""

    def __init__(self, ws: Any) -> None:
        self.ws = ws
        self.inbox: list[dict] = []
        self.closed = False

    async def send(self, msg: dict) -> None:
        await self.ws.write_message(json.dumps({"jsonrpc": "2.0", **msg}))

    async def next(self, predicate: Callable[[dict], bool], timeout: float = TIMEOUT) -> dict:
        """The first message (already received or arriving) matching `predicate`."""
        for i, msg in enumerate(self.inbox):
            if predicate(msg):
                return self.inbox.pop(i)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise AssertionError(f"timed out; inbox: {self.inbox}")
            raw = await asyncio.wait_for(self.ws.read_message(), remaining)
            if raw is None:
                self.closed = True
                raise ConnectionError(f"socket closed; inbox: {self.inbox}")
            msg = json.loads(raw)
            if predicate(msg):
                return msg
            self.inbox.append(msg)

    async def request(self, id: Any, method: str, params: Any = None) -> dict:
        msg = {"id": id, "method": method}
        if params is not None:
            msg["params"] = params
        await self.send(msg)
        return await self.next(lambda m: "method" not in m and m.get("id") == id)

    async def notification(self, method: str, **match: Any) -> dict:
        def pred(m: dict) -> bool:
            if m.get("method") != method or "id" in m:
                return False
            params = m.get("params") or {}
            return all(params.get(k) == v for k, v in match.items())

        return await self.next(pred)

    async def wait_closed(self, timeout: float = TIMEOUT) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            raw = await asyncio.wait_for(self.ws.read_message(), max(0.0, deadline - loop.time()))
            if raw is None:
                self.closed = True
                return
            self.inbox.append(json.loads(raw))

    def close(self) -> None:
        self.ws.close()


@pytest.fixture
def open_tab(jp_ws_fetch: Callable[..., Any]) -> Callable[[], Any]:
    tabs: list[Tab] = []

    async def opener() -> Tab:
        ws = await jp_ws_fetch("localpilot", "rpc")
        tab = Tab(ws)
        tabs.append(tab)
        return tab

    yield opener
    for tab in tabs:
        tab.ws.close()


@pytest.fixture
def localpilot(jp_serverapp: Any) -> Any:
    """The server extension's bridge (owns the core process)."""
    return jp_serverapp.web_app.settings["localpilot"]


def is_response(id: Any) -> Callable[[dict], bool]:
    return lambda m: "method" not in m and m.get("id") == id

