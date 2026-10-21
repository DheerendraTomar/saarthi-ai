"""Multiplexes browser tabs (one WebSocket each) onto the server's single core process.

Routing rules (one JSON-RPC message per WebSocket text frame):

Tab → core
- `initialize` is answered by the server: the first one starts the core with that
  tab's `settings`; every tab gets the cached result under its own id.
- `shutdown` is answered `{}` locally (it must never stop the shared core); `exit` is dropped.
- Other requests: the id is rewritten to the string `"<tab>:<json id>"` and forwarded;
  the core's response is routed back to that tab with its original id restored.
  While the core is stopped/crashed they fail at once with -32603.
- `completion/request|cancel|accepted|rejected|outcome`: `params.requestId` is rewritten to
  `"<tab>:<requestId>"`, so two tabs' request ids never collide in the core.
- `chat/send` records `sessionId → tab` (ownership) unless the session has a running
  turn whose owner is still connected (the core will refuse that send, and the turn's
  events must keep going to the tab running it). A turn runs from a successful
  `chat/send` response (which also gives the session to the tab that sent it) until the
  session's `chat/done`. Other `chat/*` requests naming a session whose owner is gone
  adopt it; a `chat/history` that adopts a session is followed (after its response) by a
  replay of that session's pending `chat/toolCall`.
- `chat/deleteSession` / `chat/clearSessions` never adopt a session (a tab may delete a
  session another tab owns; the core refuses one with a running turn). On success the
  bridge drops its ownership / running / pending-call entries for the deleted sessions
  (for `clearSessions`: every session not in `skipped`) and sends every *other* tab
  `localpilot/sessionsChanged` (`{deleted: [id]}` or `{cleared: true, skipped}`), so
  their chat panels refresh; the deleting tab updates its own UI from the response.
- Document sync is refcounted per (uri, tab): `didOpen` is forwarded only for the first
  tab opening a uri (a later tab's `didOpen` becomes a full-text `didChange`, so the
  core holds that tab's text), `didChange`/`didSave` always, `didClose` only when the
  last tab closes it; a closing tab's documents get a synthesized `didClose`.
- Other notifications are forwarded (queued by the core while starting).
- Responses to core→client requests are forwarded only by the tab the request went to.

Core → tabs
- Responses go to the tab that owns the namespaced id; unknown ids are dropped.
- `chat/*` notifications go only to the tab owning their `sessionId`; dropped while that
  owner is disconnected (until a tab adopts the session); broadcast for unknown sessions.
  All other notifications are broadcast.
- `workspace/runCommand` is answered by the server (`commands.run_command` in the
  server root). `workspace/applyEdit` goes exactly to the tab owning `params.sessionId`;
  if that owner is gone (or the session is unknown / missing) the core gets -32603
  "owning tab disconnected" — never a stranger tab. Other core→client requests → -32601.
- The last `chat/toolCall` awaiting approval is kept per session (cleared by its
  `chat/toolResult`, the session's `chat/done`, or a `chat/approve` for it).

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
from typing import Any, Callable, Optional, Protocol, Union

from .commands import run_command
from .core_process import CoreCrashed, CoreNotRunning, CoreProcess, CoreStopped

INTERNAL_ERROR = -32603
METHOD_NOT_FOUND = -32601
PARSE_ERROR = -32700
#: Methods whose `params.requestId` is namespaced per tab.
REQUEST_ID_METHODS = frozenset(
    {"completion/request", "completion/cancel", "completion/accepted", "completion/rejected", "completion/outcome"}
)
#: Session deletions: never adopt the session; on success the bridge forgets it and tells the other tabs.
DELETE_METHODS = frozenset({"chat/deleteSession", "chat/clearSessions"})
#: Bridge-originated notification to the other tabs after a successful deletion.
SESSIONS_CHANGED = "localpilot/sessionsChanged"
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
        # session → (toolCallId, raw chat/toolCall line) still awaiting approval
        self._pending_calls: dict[str, tuple[str, str]] = {}
        # forwarded chat/history id → session whose pending call is replayed after the response
        self._replay_after: dict[str, str] = {}
        # forwarded chat/send id → [session, whether it had a running turn when forwarded,
        # stale]; a successful response starts a turn unless the turn already ended (stale)
        self._send_after: dict[str, list[Any]] = {}
        # forwarded chat/deleteSession|clearSessions id → the deleted session (None: clear all)
        self._delete_after: dict[str, Optional[str]] = {}
        # sessions with a running turn (successful chat/send until chat/done)
        self._running: set[str] = set()
        # document uri → tabs that have it open
        self._docs: dict[str, set[str]] = {}
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
        return {
            "core": self.core_state,
            "ollama": self.core.ollama_status if self.core is not None else None,
            # The core's workspace: clients build `file://` URIs of their documents from it.
            "rootDir": str(self.root_dir),
        }

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
            self._replay_after.pop(key, None)
            self._send_after.pop(key, None)
            self._delete_after.pop(key, None)
        for uri in [u for u, holders in self._docs.items() if tab_id in holders]:
            self._docs[uri].discard(tab_id)
            if not self._docs[uri]:
                del self._docs[uri]
                self._send_core(json.dumps({"jsonrpc": "2.0", "method": "textDocument/didClose", "params": {"uri": uri}}))
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
            if method == "exit":
                return
            if method.startswith("textDocument/"):
                forward = self._track_document(tab_id, method, params)
                if forward is None:
                    return
                if isinstance(forward, str):
                    line = forward
            if method in REQUEST_ID_METHODS:
                self._namespace_request_id(tab_id, msg)
                line = json.dumps(msg)
            self._send_core(line)
            return
        id_value = msg["id"]
        if method == "initialize":
            await self._initialize(tab_id, id_value, params)
            return
        if method == "shutdown":
            self._send_tab(tab_id, _result(id_value, {}))
            return
        replay_session: Optional[str] = None
        send_session = params.get("sessionId") if method == "chat/send" else None
        if method.startswith("chat/") and method not in DELETE_METHODS:
            replay_session = self._track_chat_request(tab_id, method, params)
        if method in REQUEST_ID_METHODS:
            self._namespace_request_id(tab_id, msg)

        core = self.core
        if core is None or core.state not in ("starting", "ready"):
            self._send_tab(
                tab_id,
                _error(id_value, INTERNAL_ERROR, f"LocalPilot core is not running (state: {self.core_state})"),
            )
            return
        forwarded = f"{tab_id}:{_key(id_value)}"
        self._pending_client[forwarded] = (tab_id, id_value)
        if replay_session is not None:
            self._replay_after[forwarded] = replay_session
        if isinstance(send_session, str):
            self._send_after[forwarded] = [send_session, send_session in self._running, False]
        if method == "chat/clearSessions":
            self._delete_after[forwarded] = None
        elif method == "chat/deleteSession" and isinstance(params.get("sessionId"), str):
            self._delete_after[forwarded] = params["sessionId"]
        msg["id"] = forwarded
        if not self._send_core(json.dumps(msg)):
            self._pending_client.pop(forwarded, None)
            self._replay_after.pop(forwarded, None)
            self._send_after.pop(forwarded, None)
            self._delete_after.pop(forwarded, None)
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

    def _track_chat_request(self, tab_id: str, method: str, params: dict[str, Any]) -> Optional[str]:
        """Records session ownership; returns the session whose pending tool call should be
        replayed to this tab after the response (a `chat/history` adopting it)."""
        session = params.get("sessionId")
        if not isinstance(session, str):
            return None
        owner = self._owners.get(session)
        adopting = owner is not None and owner not in self.tabs
        # A send into another connected tab's running turn is refused by the core:
        # it must not take that turn's events away from the tab running it.
        takes_over = method == "chat/send" and session not in self._running
        if takes_over or owner is None or adopting:
            self._owners[session] = tab_id
        if method == "chat/approve":
            pending = self._pending_calls.get(session)
            if pending is not None and pending[0] == params.get("toolCallId"):
                del self._pending_calls[session]
        if method == "chat/history" and adopting and session in self._pending_calls:
            return session
        return None

    @staticmethod
    def _namespace_request_id(tab_id: str, msg: dict[str, Any]) -> None:
        params = msg.get("params")
        if isinstance(params, dict) and isinstance(params.get("requestId"), (str, int)):
            params["requestId"] = f"{tab_id}:{params['requestId']}"

    def _track_document(self, tab_id: str, method: str, params: dict[str, Any]) -> Union[bool, str, None]:
        """Refcounts open documents per tab. Returns True to forward the notification as is,
        a replacement line to forward instead, or None to drop it."""
        uri = params.get("uri")
        if not isinstance(uri, str):
            return True
        holders = self._docs.get(uri)
        if method == "textDocument/didOpen":
            self._docs.setdefault(uri, set()).add(tab_id)
            if not holders:
                return True
            # Another tab holds the uri: the core already has it open, so bring its
            # text up to date with this tab's instead of opening it twice.
            if not isinstance(params.get("text"), str):
                return None
            change: dict[str, Any] = {"uri": uri, "contentChanges": [{"text": params["text"]}]}
            if "version" in params:
                change["version"] = params["version"]
            return json.dumps({"jsonrpc": "2.0", "method": "textDocument/didChange", "params": change})
        if method == "textDocument/didClose":
            if holders is None:
                return True  # not tracked (opened before a restart): let the core decide
            holders.discard(tab_id)
            if holders:
                return None
            del self._docs[uri]
            return True
        return True

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
        sent = self._send_after.pop(forwarded, None)
        if sent is not None and "error" not in msg:
            # The core accepted this tab's turn: it is this tab's, and it runs unless it
            # already ended (its chat/done can beat this answer).
            sent_session, _, stale = sent
            self._owners[sent_session] = tab_id
            if not stale:
                self._running.add(sent_session)
        deleting = forwarded in self._delete_after
        deleted_session = self._delete_after.pop(forwarded, None)
        msg["id"] = original
        self._send_tab(tab_id, json.dumps(msg))
        if deleting and "error" not in msg:
            self._sessions_deleted(tab_id, deleted_session, msg.get("result"))
        session = self._replay_after.pop(forwarded, None)
        if session is not None and self._owners.get(session) == tab_id and session in self._pending_calls:
            self._send_tab(tab_id, self._pending_calls[session][1])

    def _sessions_deleted(self, tab_id: str, session: Optional[str], result: Any) -> None:
        """A successful `chat/deleteSession` (`session`) or `chat/clearSessions` (None) from `tab_id`."""
        if session is not None:
            gone = {session}
            params: dict[str, Any] = {"deleted": [session]}
        else:
            raw = result.get("skipped") if isinstance(result, dict) else None
            skipped = [s for s in raw if isinstance(s, str)] if isinstance(raw, list) else []
            known = set(self._owners) | set(self._running) | set(self._pending_calls)
            gone = known - set(skipped)
            params = {"cleared": True, "skipped": skipped}
        for s in gone:
            self._owners.pop(s, None)
            self._running.discard(s)
            self._pending_calls.pop(s, None)
        line = json.dumps({"jsonrpc": "2.0", "method": SESSIONS_CHANGED, "params": params})
        for other in list(self.tabs):
            if other != tab_id:
                self._send_tab(other, line)

    def _notification_from_core(self, method: str, msg: dict[str, Any], line: str) -> None:
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        if not method.startswith("chat/"):
            self._broadcast(line)
            return
        session = params.get("sessionId")
        call = params.get("toolCallId")
        if isinstance(session, str):
            pending = self._pending_calls.get(session)
            if method == "chat/done":
                self._running.discard(session)
                # The core spawns the turn before answering chat/send, so a turn that ends at
                # once can finish before that answer: a send forwarded while nothing ran is that
                # turn, and must not mark the session running. A send forwarded during another
                # turn may still be accepted after this done; its answer decides.
                for entry in self._send_after.values():
                    if entry[0] == session and not entry[1]:
                        entry[2] = True
            if method == "chat/toolCall" and isinstance(call, str) and params.get("requiresApproval"):
                self._pending_calls[session] = (call, line)
            elif method == "chat/done" or (
                method == "chat/toolResult" and pending is not None and pending[0] == call
            ):
                self._pending_calls.pop(session, None)
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
            params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
            session = params.get("sessionId")
            tab_id = self._owners.get(session) if isinstance(session, str) else None
            if tab_id is None or tab_id not in self.tabs:
                self._send_core(
                    _error(id_value, INTERNAL_ERROR, f"owning tab disconnected (session {session!r}); edit not applied")
                )
                return
            self._pending_core[_key(id_value)] = tab_id
            self._send_tab(tab_id, line)
        else:
            self._send_core(_error(id_value, METHOD_NOT_FOUND, f"method not found: {method}"))

    async def _run_command(self, id_value: Any, params: dict[str, Any]) -> None:
        result = await run_command(params, self.root_dir)
        self._send_core(_result(id_value, result))

    def _broadcast(self, line: str) -> None:
        for tab_id in list(self.tabs):
            self._send_tab(tab_id, line)

    # ------------------------------------------------------------------ core exit

    def _on_core_exit(self, was_ready: bool) -> None:
        pending, self._pending_client = self._pending_client, {}
        for tab_id, original in pending.values():
            self._send_tab(tab_id, _error(original, INTERNAL_ERROR, "LocalPilot core exited"))
        self._pending_core.clear()
        self._replay_after.clear()
        self._send_after.clear()
        self._delete_after.clear()
        self._running.clear()
        self._pending_calls.clear()
        # The next core starts with an empty overlay; tabs re-send didOpen after reconnecting.
        self._docs.clear()
        if not was_ready:
            return
        for tab_id, conn in list(self.tabs.items()):
            try:
                conn.close(CLOSE_RESTART, "LocalPilot core restarted")
            except Exception:
                self.log.debug("LocalPilot: closing tab %s failed", tab_id)
