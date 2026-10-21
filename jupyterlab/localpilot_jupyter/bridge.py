"""Multiplexes browser tabs (one WebSocket each) onto the server's single core process.

Routing rules (one JSON-RPC message per WebSocket text frame):

Tab → core
- `initialize` is answered by the server: the first one starts the core with that
  tab's `settings`; every tab gets the cached result under its own id.
- `shutdown` is answered `{}` locally (it must never stop the shared core); `exit` is dropped.
- Other requests: the id is rewritten to the string `"<tab>:<json id>"` and forwarded;
  the core's response is routed back to that tab with its original id restored.
  While the core is stopped/crashed they fail at once with -32603.
- `chat/send` records `sessionId → tab` (ownership). Other `chat/*` requests naming a
  session whose owner is gone adopt it. `chat/approve` (not `deny`) marks that tool call
  as the next to execute (used to route `workspace/applyEdit`).
- Notifications are forwarded (queued by the core while starting).
- Responses to core→client requests are forwarded only by the tab the request went to.

Core → tabs
- Responses go to the tab that owns the namespaced id; unknown ids are dropped.
- `chat/*` notifications go only to the tab owning their `sessionId`; dropped while that
  owner is disconnected (until a tab adopts the session); broadcast for unknown sessions.
  All other notifications are broadcast.
- `workspace/runCommand` is answered by the server (`commands.run_command` in the
  server root). `workspace/applyEdit` (its params carry no sessionId) goes to the owner of
  the session whose tool call was most recently approved/auto-approved and has no
  `chat/toolResult` yet; else to the most recently connected tab; no tab → -32603.
  Other core→client requests → -32601.

Lifecycle
- A tab closing answers every core→client request pending on it with -32603.
- When a core process that had been ready exits (crash, restart, stop), every in-flight
  tab request is answered with -32603 and every tab socket is closed (code 1012) so
  clients reconnect, re-initialize (cached) and re-send `didOpen` to the new core.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

from .commands import run_command
from .core_process import CoreCrashed, CoreNotRunning, CoreProcess, CoreStopped

INTERNAL_ERROR = -32603
METHOD_NOT_FOUND = -32601
PARSE_ERROR = -32700
#: WebSocket close code "Service Restart".
CLOSE_RESTART = 1012


class TabConnection(Protocol):
    def send(self, text: str) -> None: ...

    def close(self, code: Optional[int] = None, reason: Optional[str] = None) -> None: ...


def _key(id_value: Any) -> str:
    return json.dumps(id_value, sort_keys=True)


def _error(id_value: Any, code: int, message: str) -> str:
    return json.dumps({"jsonrpc": "2.0", "id": id_value, "error": {"code": code, "message": message}})


def _result(id_value: Any, result: Any) -> str:
    return json.dumps({"jsonrpc": "2.0", "id": id_value, "result": result})


class Bridge:
    """One per Jupyter server. Creates the core lazily (first `initialize`) via `core_factory`."""

    def __init__(
        self,
        core_factory: Callable[[], CoreProcess],
        root_dir: Path,
        log: Optional[logging.Logger] = None,
    ) -> None:
        self.core_factory = core_factory
        self.root_dir = Path(root_dir)
        self.log = log or logging.getLogger("localpilot_jupyter")
        self.core: Optional[CoreProcess] = None
        self.tabs: dict[str, TabConnection] = {}
        self._tab_seq = 0
        # forwarded id → (tab id, original id)
        self._pending_client: dict[str, tuple[str, Any]] = {}
        # core→client request id (json key) → tab id
        self._pending_core: dict[str, str] = {}
        # chat session → owning tab id
        self._owners: dict[str, str] = {}
        # tool calls announced and not finished: toolCallId → sessionId
        self._open_calls: dict[str, str] = {}
        # toolCallIds approved / auto-approved, oldest first
        self._activated: list[str] = []
        self._tasks: set[asyncio.Task[Any]] = set()

    # ------------------------------------------------------------------ core

    def _ensure_core(self) -> CoreProcess:
        if self.core is None:
            core = self.core_factory()
            core.add_listener(self._from_core)
            core.add_exit_listener(self._on_core_exit)
            self.core = core
        return self.core

    @property
    def core_state(self) -> str:
        return self.core.state if self.core is not None else "stopped"

    def status(self) -> dict[str, Any]:
        return {"core": self.core_state, "ollama": self.core.ollama_status if self.core is not None else None}

    async def restart(self, settings: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        """Restarts the core (settings change); starts it if it never ran. Returns `status()`."""
        core = self._ensure_core()
        await core.restart(settings)
        return self.status()

    async def stop(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self.core is not None:
            await self.core.stop()

    # ------------------------------------------------------------------ tabs

    def register(self, conn: TabConnection) -> str:
        self._tab_seq += 1
        tab_id = f"t{self._tab_seq}"
        self.tabs[tab_id] = conn
        return tab_id

    def unregister(self, tab_id: str) -> None:
        if self.tabs.pop(tab_id, None) is None:
            return
        for key in [k for k, (tab, _) in self._pending_client.items() if tab == tab_id]:
            del self._pending_client[key]
        for key in [k for k, tab in self._pending_core.items() if tab == tab_id]:
            del self._pending_core[key]
            self._send_core(_error(json.loads(key), INTERNAL_ERROR, "the JupyterLab tab handling this request was closed"))

    def _send_tab(self, tab_id: str, text: str) -> None:
        conn = self.tabs.get(tab_id)
        if conn is None:
            return
        try:
            conn.send(text)
        except Exception:  # closed socket: its on_close unregisters it
            self.log.debug("LocalPilot: dropped a message to closed tab %s", tab_id)

    def _send_core(self, text: str) -> bool:
        if self.core is None:
            return False
        try:
            self.core.send_line(text)
            return True
        except CoreNotRunning:
            return False

    def _spawn(self, coro: Any) -> None:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # ------------------------------------------------------------------ tab → core

    async def handle_from_tab(self, tab_id: str, text: str) -> None:
        for line in text.split("\n"):
            if line.strip():
                await self._handle_message(tab_id, line)

    async def _handle_message(self, tab_id: str, line: str) -> None:
        try:
            msg = json.loads(line)
        except ValueError:
            self._send_tab(tab_id, _error(None, PARSE_ERROR, "parse error"))
            return
        if not isinstance(msg, dict):
            self._send_tab(tab_id, _error(None, PARSE_ERROR, "expected a JSON-RPC object"))
            return
        method = msg.get("method")
        has_id = "id" in msg and msg["id"] is not None
        if not isinstance(method, str):
            if has_id:
                self._response_from_tab(tab_id, msg, line)
            return
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        if not has_id:
            if method != "exit":
                self._send_core(line)
            return
        id_value = msg["id"]
        if method == "initialize":
            await self._initialize(tab_id, id_value, params)
            return
        if method == "shutdown":
            self._send_tab(tab_id, _result(id_value, {}))
            return
        if method.startswith("chat/"):
            self._track_chat_request(tab_id, method, params)

        core = self.core
        if core is None or core.state not in ("starting", "ready"):
            self._send_tab(
                tab_id,
                _error(id_value, INTERNAL_ERROR, f"LocalPilot core is not running (state: {self.core_state})"),
            )
            return
        forwarded = f"{tab_id}:{_key(id_value)}"
        self._pending_client[forwarded] = (tab_id, id_value)
        msg["id"] = forwarded
        if not self._send_core(json.dumps(msg)):
            self._pending_client.pop(forwarded, None)
            self._send_tab(tab_id, _error(id_value, INTERNAL_ERROR, "LocalPilot core is not running"))

    async def _initialize(self, tab_id: str, id_value: Any, params: dict[str, Any]) -> None:
        settings = params.get("settings") if isinstance(params.get("settings"), dict) else {}
        try:
            core = self._ensure_core()
        except Exception as err:  # binary not found, …
            self._send_tab(tab_id, _error(id_value, INTERNAL_ERROR, str(err)))
            return
        if core.state == "crashed":
            self._send_tab(
                tab_id,
                _error(id_value, INTERNAL_ERROR, "LocalPilot core crashed; POST /localpilot/restart to start it again"),
            )
            return
        try:
            result = await core.start(settings)
        except (CoreCrashed, CoreStopped) as err:
            self._send_tab(tab_id, _error(id_value, INTERNAL_ERROR, str(err)))
            return
        self._send_tab(tab_id, _result(id_value, core.initialize_result or result))

    def _track_chat_request(self, tab_id: str, method: str, params: dict[str, Any]) -> None:
        session = params.get("sessionId")
        if isinstance(session, str):
            owner = self._owners.get(session)
            if method == "chat/send" or owner is None or owner not in self.tabs:
                self._owners[session] = tab_id
        if method == "chat/approve" and params.get("decision") != "deny":
            call = params.get("toolCallId")
            if isinstance(call, str):
                if isinstance(session, str) and call not in self._open_calls:
                    self._open_calls[call] = session
                self._activate(call)

    def _response_from_tab(self, tab_id: str, msg: dict[str, Any], line: str) -> None:
        key = _key(msg["id"])
        if self._pending_core.get(key) != tab_id:
            self.log.debug("LocalPilot: ignored a response from tab %s to unknown request %s", tab_id, key)
            return
        del self._pending_core[key]
        self._send_core(line)

    # ------------------------------------------------------------------ core → tabs

    def _from_core(self, line: str) -> None:
        try:
            msg = json.loads(line)
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        method = msg.get("method")
        if isinstance(method, str):
            if "id" in msg and msg["id"] is not None:
                self._request_from_core(msg, line)
            else:
                self._notification_from_core(method, msg, line)
            return
        forwarded = msg.get("id")
        if not isinstance(forwarded, str) or forwarded not in self._pending_client:
            self.log.debug("LocalPilot: dropped a core response to unknown id %r", forwarded)
            return
        tab_id, original = self._pending_client.pop(forwarded)
        msg["id"] = original
        self._send_tab(tab_id, json.dumps(msg))

    def _notification_from_core(self, method: str, msg: dict[str, Any], line: str) -> None:
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        if not method.startswith("chat/"):
            self._broadcast(line)
            return
        session = params.get("sessionId")
        call = params.get("toolCallId")
        if method == "chat/toolCall" and isinstance(call, str) and isinstance(session, str):
            self._open_calls[call] = session
            if not params.get("requiresApproval"):
                self._activate(call)
        elif method == "chat/toolResult" and isinstance(call, str):
            self._finish_call(call)
        elif method == "chat/done" and isinstance(session, str):
            for done in [c for c, s in self._open_calls.items() if s == session]:
                self._finish_call(done)
        owner = self._owners.get(session) if isinstance(session, str) else None
        if owner is None:
            self._broadcast(line)
        elif owner in self.tabs:
            self._send_tab(owner, line)
        # else: the owner is disconnected; dropped until a tab adopts the session

    def _request_from_core(self, msg: dict[str, Any], line: str) -> None:
        method = msg["method"]
        id_value = msg["id"]
        if method == "workspace/runCommand":
            params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
            self._spawn(self._run_command(id_value, params))
        elif method == "workspace/applyEdit":
            tab_id = self._apply_edit_target()
            if tab_id is None:
                self._send_core(_error(id_value, INTERNAL_ERROR, "no JupyterLab tab is connected to apply the edit"))
                return
            self._pending_core[_key(id_value)] = tab_id
            self._send_tab(tab_id, line)
        else:
            self._send_core(_error(id_value, METHOD_NOT_FOUND, f"method not found: {method}"))

    async def _run_command(self, id_value: Any, params: dict[str, Any]) -> None:
        result = await run_command(params, self.root_dir)
        self._send_core(_result(id_value, result))

    def _activate(self, call: str) -> None:
        if call in self._activated:
            self._activated.remove(call)
        self._activated.append(call)

    def _finish_call(self, call: str) -> None:
        self._open_calls.pop(call, None)
        if call in self._activated:
            self._activated.remove(call)

    def _apply_edit_target(self) -> Optional[str]:
        for call in reversed(self._activated):
            session = self._open_calls.get(call)
            owner = self._owners.get(session) if session is not None else None
            if owner is not None and owner in self.tabs:
                return owner
        return next(reversed(self.tabs), None)

    def _broadcast(self, line: str) -> None:
        for tab_id in list(self.tabs):
            self._send_tab(tab_id, line)

    # ------------------------------------------------------------------ core exit

    def _on_core_exit(self, was_ready: bool) -> None:
        pending, self._pending_client = self._pending_client, {}
        for tab_id, original in pending.values():
            self._send_tab(tab_id, _error(original, INTERNAL_ERROR, "LocalPilot core exited"))
        self._pending_core.clear()
        self._open_calls.clear()
        self._activated.clear()
        if not was_ready:
            return
        for tab_id, conn in list(self.tabs.items()):
            try:
                conn.close(CLOSE_RESTART, "LocalPilot core restarted")
            except Exception:
                self.log.debug("LocalPilot: closing tab %s failed", tab_id)
