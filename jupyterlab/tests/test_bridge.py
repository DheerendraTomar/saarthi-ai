"""The /localpilot/rpc bridge and the REST endpoints.

End-to-end tests run a real Jupyter server (pytest-jupyter) with the fake core
subprocess; routing edge cases that the fake core cannot produce (a core-sent
`workspace/runCommand`, a core exit at a chosen moment) drive `Bridge` directly
with a stub core.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Callable

import pytest
from tornado.httpclient import HTTPClientError

from localpilot_jupyter.bridge import Bridge
from localpilot_jupyter.core_process import CoreNotRunning

from .conftest import TIMEOUT, Tab, eventually, is_response

SETTINGS = {"completionModel": "fake-model", "completionsEnabled": True}


def completion(id: int, line: int) -> dict:
    return {
        "id": id,
        "method": "completion/request",
        "params": {"uri": "file:///w/a.py", "position": {"line": line, "character": 4}},
    }


async def init(tab: Tab, settings: dict | None = None) -> dict:
    reply = await tab.request(1, "initialize", {"workspaceRoot": "/ignored", "settings": settings or SETTINGS})
    assert "result" in reply, reply
    return reply["result"]


async def start_turn(tab: Tab, id_base: int) -> tuple[str, str]:
    """Starts a scripted fake-core chat turn; returns (sessionId, toolCallId) once approval is asked."""
    session = (await tab.request(id_base, "chat/newSession"))["result"]["sessionId"]
    sent = await tab.request(id_base + 1, "chat/send", {"sessionId": session, "message": "edit a.py"})
    assert sent.get("result") == {}, sent
    call = await tab.notification("chat/toolCall", sessionId=session)
    return session, call["params"]["toolCallId"]


def mentions_session(msg: dict, session: str) -> bool:
    return isinstance(msg.get("params"), dict) and msg["params"].get("sessionId") == session


# ------------------------------------------------------------------ end to end


async def test_two_tabs_get_their_own_completion_responses(
    open_tab: Callable[[], Any], localpilot: Bridge, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Both completions are in flight at once inside the core.
    monkeypatch.setenv("FAKE_DELAY_MS", "150")
    a, b = await open_tab(), await open_tab()
    ra = await init(a)
    rb = await init(b, {"completionModel": "ignored"})
    assert ra["capabilities"] == rb["capabilities"]
    assert localpilot.core is not None and localpilot.core.launches == 1
    assert localpilot.core.settings == SETTINGS  # settings come from the first client

    # Same numeric id from both tabs; the fake echoes the position, so each answer is attributable.
    await a.send(completion(2, line=10))
    await b.send(completion(2, line=20))
    resp_a = await a.next(is_response(2))
    resp_b = await b.next(is_response(2))
    assert type(resp_a["id"]) is int and type(resp_b["id"]) is int
    assert resp_a["result"]["items"][0]["range"]["start"]["line"] == 10
    assert resp_b["result"]["items"][0]["range"]["start"]["line"] == 20

    # Barrier: anything misrouted would have arrived before these later answers.
    await a.request(3, "ollama/status")
    await b.request(3, "ollama/status")
    for tab in (a, b):
        assert not [m for m in tab.inbox if "result" in m or "error" in m], tab.inbox


async def test_closing_tab_does_not_affect_other_tab_turn(open_tab: Callable[[], Any], localpilot: Bridge) -> None:
    a, b = await open_tab(), await open_tab()
    await init(a)
    await init(b)
    session_a, call_a = await start_turn(a, 10)
    session_b, _ = await start_turn(b, 10)

    b.close()
    await eventually(lambda: len(localpilot.tabs) == 1, what="tab b unregistered")

    approved = await a.request(20, "chat/approve", {"sessionId": session_a, "toolCallId": call_a, "decision": "once"})
    assert approved.get("result") == {}
    edit = await a.next(lambda m: m.get("method") == "workspace/applyEdit")
    await a.send({"id": edit["id"], "result": {"applied": True}})
    result = await a.notification("chat/toolResult", sessionId=session_a)
    assert result["params"]["ok"] is True
    done = await a.notification("chat/done", sessionId=session_a)
    assert done["params"]["stopReason"] == "done"

    assert localpilot.core.state == "ready" and localpilot.core.launches == 1
    assert not [m for m in a.inbox if mentions_session(m, session_b)], a.inbox


async def test_apply_edit_routed_to_owning_tab(open_tab: Callable[[], Any]) -> None:
    a, b = await open_tab(), await open_tab()
    await init(a)
    await init(b)
    session_a, call_a = await start_turn(a, 10)
    await a.request(20, "chat/approve", {"sessionId": session_a, "toolCallId": call_a, "decision": "once"})
    edit = await a.next(lambda m: m.get("method") == "workspace/applyEdit")
    assert edit["id"] < 0
    await a.send({"id": edit["id"], "result": {"applied": True}})
    assert (await a.notification("chat/toolResult", sessionId=session_a))["params"]["ok"] is True
    await a.notification("chat/done", sessionId=session_a)

    await b.request(30, "ollama/status")  # barrier
    assert not [m for m in b.inbox if m.get("method") == "workspace/applyEdit"], b.inbox
    assert not [m for m in b.inbox if mentions_session(m, session_a)], b.inbox


async def test_two_tabs_concurrent_turns_each_get_their_own_apply_edit(open_tab: Callable[[], Any]) -> None:
    a, b = await open_tab(), await open_tab()
    await init(a)
    await init(b)
    session_a, call_a = await start_turn(a, 10)
    session_b, call_b = await start_turn(b, 10)
    # Both approvals are in before either edit is requested; b approves last.
    await a.send({"id": 20, "method": "chat/approve", "params": {"sessionId": session_a, "toolCallId": call_a, "decision": "once"}})
    await b.send({"id": 20, "method": "chat/approve", "params": {"sessionId": session_b, "toolCallId": call_b, "decision": "once"}})
    for tab, session in ((a, session_a), (b, session_b)):
        edit = await tab.next(lambda m: m.get("method") == "workspace/applyEdit")
        assert edit["params"]["sessionId"] == session
        await tab.send({"id": edit["id"], "result": {"applied": True}})
    for tab, session in ((a, session_a), (b, session_b)):
        assert (await tab.notification("chat/toolResult", sessionId=session))["params"]["ok"] is True
        assert (await tab.notification("chat/done", sessionId=session))["params"]["stopReason"] == "done"
    for tab, other in ((a, session_b), (b, session_a)):
        assert not [m for m in tab.inbox if mentions_session(m, other)], tab.inbox


async def test_completion_cancel_from_another_tab_does_not_cancel(
    open_tab: Callable[[], Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_DELAY_MS", "200")
    a, b = await open_tab(), await open_tab()
    await init(a)
    await init(b)
    request = completion(2, line=5)
    request["params"]["requestId"] = "r1"
    await a.send(request)
    await b.send({"method": "completion/cancel", "params": {"requestId": "r1"}})
    reply = await a.next(is_response(2))
    assert reply["result"]["items"][0]["text"] == "fake()"


async def test_websocket_and_restart_need_terminal_execute_permission(
    jp_fetch: Callable[..., Any], jp_ws_fetch: Callable[..., Any], jp_serverapp: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    asked: list[tuple[str, str]] = []

    def is_authorized(handler: Any, user: Any, action: str, resource: str) -> bool:
        asked.append((action, resource))
        return resource != "terminals"

    monkeypatch.setattr(jp_serverapp.web_app.settings["authorizer"], "is_authorized", is_authorized)
    with pytest.raises(HTTPClientError) as err:
        await jp_ws_fetch("localpilot", "rpc")
    assert err.value.code == 403
    with pytest.raises(HTTPClientError) as err:
        await jp_fetch("localpilot", "restart", method="POST", body="{}")
    assert err.value.code == 403
    assert asked.count(("execute", "terminals")) == 2
    assert (await jp_fetch("localpilot", "status")).code == 200


async def test_notifications_are_broadcast_and_shutdown_is_not_forwarded(
    open_tab: Callable[[], Any], localpilot: Bridge
) -> None:
    a, b = await open_tab(), await open_tab()
    await init(a)
    await init(b)
    # `ollama/pull` progress and the resulting status are not chat/*: every tab sees them.
    await a.request(2, "ollama/pull", {"model": "m"})
    for tab in (a, b):
        await tab.notification("ollama/pullProgress", model="m", completed=100)
    # A tab's shutdown must never stop the shared core.
    assert (await a.request(3, "shutdown"))["result"] == {}
    assert (await b.request(4, "ollama/status"))["result"]["ollama"] == "ok"
    assert localpilot.core.state == "ready"


async def test_status_and_restart_endpoints(
    jp_fetch: Callable[..., Any], open_tab: Callable[[], Any], localpilot: Bridge
) -> None:
    root_dir = str(localpilot.root_dir)
    assert Path(root_dir).is_absolute()
    status = json.loads((await jp_fetch("localpilot", "status")).body)
    assert status == {"core": "stopped", "ollama": None, "rootDir": root_dir}

    a = await open_tab()
    await init(a)
    await eventually(lambda: localpilot.core.ollama_status, what="ollama status")
    status = json.loads((await jp_fetch("localpilot", "status")).body)
    assert status == {"core": "ready", "ollama": {"ollama": "ok", "detail": "Ollama is running"}, "rootDir": root_dir}

    reply = await jp_fetch("localpilot", "restart", method="POST", body=json.dumps({"settings": {"completionModel": "new"}}))
    assert json.loads(reply.body)["core"] == "ready"
    assert localpilot.core.launches == 2
    assert localpilot.core.settings == {"completionModel": "new"}
    # Tabs are disconnected so they reconnect and re-sync their documents with the new core.
    await a.wait_closed()

    c = await open_tab()
    await init(c, {"completionModel": "ignored"})
    assert localpilot.core.launches == 2


async def test_endpoints_require_auth(
    jp_fetch: Callable[..., Any], jp_ws_fetch: Callable[..., Any], jp_http_port: int, localpilot: Bridge
) -> None:
    no_auth = {"Authorization": ""}
    for method, path, body in [("GET", "status", None), ("POST", "restart", "{}")]:
        with pytest.raises(HTTPClientError) as err:
            await jp_fetch("localpilot", path, method=method, body=body, headers=no_auth, follow_redirects=False)
        assert err.value.code == 403, (method, path)
    with pytest.raises(HTTPClientError) as err:
        await jp_ws_fetch("localpilot", "rpc", headers=no_auth)
    assert err.value.code == 403

    # A browser authenticates with the login cookie (set by a token-authenticated request),
    # and then the origin and XSRF checks apply.
    login = await jp_fetch("localpilot", "status")
    cookies = "; ".join(c.split(";", 1)[0] for c in login.headers.get_list("Set-Cookie"))
    assert cookies, login.headers
    # The login cookie's name is derived from the Host jp_fetch used (127.0.0.1); the WebSocket
    # client connects to localhost, so send the same Host to present the same browser session.
    host = f"127.0.0.1:{jp_http_port}"
    same_origin = f"http://{host}"
    with pytest.raises(HTTPClientError) as err:
        await jp_ws_fetch("localpilot", "rpc", headers={**no_auth, "Host": host, "Cookie": cookies, "Origin": "http://evil.example"})
    assert err.value.code == 403
    with pytest.raises(HTTPClientError) as err:  # cookie but no XSRF token
        await jp_fetch("localpilot", "restart", method="POST", body="{}", headers={**no_auth, "Cookie": cookies})
    assert err.value.code == 403
    assert localpilot.core is None  # nothing was started by the rejected requests

    ws = await jp_ws_fetch("localpilot", "rpc", headers={**no_auth, "Host": host, "Cookie": cookies, "Origin": same_origin})
    ws.close()
    xsrf = {**no_auth, "Cookie": f"{cookies}; _xsrf=lp-test", "X-XSRFToken": "lp-test", "Origin": same_origin}
    assert (await jp_fetch("localpilot", "status", headers={**no_auth, "Cookie": cookies})).code == 200
    reply = await jp_fetch("localpilot", "restart", method="POST", body="{}", headers=xsrf)
    assert json.loads(reply.body)["core"] == "ready"


# ------------------------------------------------------------------ stub core


class StubCore:
    """Just enough of CoreProcess for routing tests: records lines, emits lines on demand."""

    def __init__(self, state: str = "ready") -> None:
        self.state = state
        self.sent: list[dict] = []
        self.settings: dict | None = None
        self.initialize_result = {"capabilities": {"completion": True, "chat": True, "bench": False}}
        self.ollama_status = None
        self.launches = 1
        self._listeners: list[Callable[[str], None]] = []
        self._exit_listeners: list[Callable[[bool], None]] = []

    async def start(self, settings: dict | None = None) -> dict:
        if self.settings is None:
            self.settings = settings
        return self.initialize_result

    async def stop(self) -> None:
        self.state = "stopped"

    def send_line(self, line: str) -> None:
        if self.state not in ("starting", "ready"):
            raise CoreNotRunning(self.state)
        self.sent.append(json.loads(line))

    def add_listener(self, cb: Callable[[str], None]) -> Callable[[], None]:
        self._listeners.append(cb)
        return lambda: self._listeners.remove(cb)

    def add_exit_listener(self, cb: Callable[[bool], None]) -> Callable[[], None]:
        self._exit_listeners.append(cb)
        return lambda: self._exit_listeners.remove(cb)

    def add_state_listener(self, cb: Callable[[str], None]) -> Callable[[], None]:
        return lambda: None

    def emit(self, msg: dict) -> None:
        for cb in list(self._listeners):
            cb(json.dumps({"jsonrpc": "2.0", **msg}))

    def exit(self, was_ready: bool = True) -> None:
        for cb in list(self._exit_listeners):
            cb(was_ready)


class StubTab:
    def __init__(self) -> None:
        self.received: list[dict] = []
        self.closed: tuple[int | None, str | None] | None = None

    def send(self, text: str) -> None:
        self.received.append(json.loads(text))

    def close(self, code: int | None = None, reason: str | None = None) -> None:
        self.closed = (code, reason)


@pytest.fixture
def stub() -> StubCore:
    return StubCore()


@pytest.fixture
def bridge(stub: StubCore, tmp_path: Path) -> Bridge:
    root = tmp_path / "root"
    root.mkdir()
    return Bridge(lambda: stub, root)


async def connect(bridge: Bridge, initialize: bool = True) -> tuple[str, StubTab]:
    tab = StubTab()
    tab_id = bridge.register(tab)
    if initialize:
        await bridge.handle_from_tab(tab_id, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"settings": {}}}))
        assert tab.received.pop()["result"]["capabilities"]["chat"] is True
    return tab_id, tab


async def send(bridge: Bridge, tab_id: str, msg: dict) -> None:
    await bridge.handle_from_tab(tab_id, json.dumps({"jsonrpc": "2.0", **msg}))


async def test_run_command_answered_server_side_with_confined_cwd(bridge: Bridge, stub: StubCore) -> None:
    _, tab = await connect(bridge)
    root = bridge.root_dir
    (root / "pkg").mkdir()
    stub.emit({"id": -3, "method": "workspace/runCommand", "params": {"command": "pwd", "cwd": str(root / "pkg")}})
    stub.emit({"id": -4, "method": "workspace/runCommand", "params": {"command": "pwd", "cwd": str(root.parent)}})
    inside = await eventually(lambda: next((m for m in stub.sent if m.get("id") == -3), None))
    outside = await eventually(lambda: next((m for m in stub.sent if m.get("id") == -4), None))
    assert inside["result"]["exitCode"] == 0
    assert Path(inside["result"]["stdout"].strip()).resolve() == (root / "pkg").resolve()
    assert outside["result"]["exitCode"] == -1 and "outside" in outside["result"]["stderr"]
    assert tab.received == []  # the browser never sees runCommand


async def test_ids_are_namespaced_and_restored(bridge: Bridge, stub: StubCore) -> None:
    a_id, a = await connect(bridge)
    b_id, b = await connect(bridge)
    await send(bridge, a_id, completion(7, 1))
    await send(bridge, b_id, completion(7, 2))
    forwarded = [m["id"] for m in stub.sent if m.get("method") == "completion/request"]
    assert forwarded == [f"{a_id}:7", f"{b_id}:7"]
    stub.emit({"id": f"{b_id}:7", "result": {"items": ["b"]}})
    stub.emit({"id": f"{a_id}:7", "result": {"items": ["a"]}})
    stub.emit({"id": "t999:7", "result": {}})  # unknown: dropped
    assert a.received == [{"jsonrpc": "2.0", "id": 7, "result": {"items": ["a"]}}]
    assert b.received == [{"jsonrpc": "2.0", "id": 7, "result": {"items": ["b"]}}]


async def test_chat_notifications_follow_session_ownership(bridge: Bridge, stub: StubCore) -> None:
    a_id, a = await connect(bridge)
    b_id, b = await connect(bridge)
    await send(bridge, a_id, {"id": 2, "method": "chat/send", "params": {"sessionId": "s1", "message": "hi"}})
    await send(bridge, b_id, {"id": 2, "method": "chat/send", "params": {"sessionId": "s2", "message": "hi"}})

    def token(session: str) -> dict:
        return {"method": "chat/token", "params": {"sessionId": session, "delta": session, "kind": "text"}}

    for session in ("s1", "s2", "s3"):
        stub.emit(token(session))
    stub.emit({"method": "status", "params": {"ollama": "down", "detail": "x"}})
    deltas = lambda tab: [m["params"].get("delta", m["method"]) for m in tab.received if "method" in m]  # noqa: E731
    assert deltas(a) == ["s1", "s3", "status"]
    assert deltas(b) == ["s2", "s3", "status"]

    bridge.unregister(a_id)
    stub.emit(token("s1"))  # owner gone: dropped, not leaked to b
    assert deltas(b) == ["s2", "s3", "status"]
    await send(bridge, b_id, {"id": 3, "method": "chat/history", "params": {"sessionId": "s1"}})
    stub.emit(token("s1"))  # b adopted s1 by asking about it
    assert deltas(b)[-1] == "s1"


def apply_edit(id: int, session: Any) -> dict:
    params: dict = {"ops": [], "save": True}
    if session is not None:
        params["sessionId"] = session
    return {"id": id, "method": "workspace/applyEdit", "params": params}


async def chat_send(bridge: Bridge, tab_id: str, session: str, id: int = 2) -> None:
    await send(bridge, tab_id, {"id": id, "method": "chat/send", "params": {"sessionId": session, "message": "hi"}})


def forwarded_send(stub: StubCore, tab_id: str, id: int) -> dict:
    return next(m for m in stub.sent if m.get("method") == "chat/send" and m["id"] == f"{tab_id}:{id}")


async def test_send_into_another_tabs_running_turn_keeps_the_owner(bridge: Bridge, stub: StubCore) -> None:
    a_id, a = await connect(bridge)
    b_id, b = await connect(bridge)
    await chat_send(bridge, a_id, "s1", id=2)
    stub.emit({"id": forwarded_send(stub, a_id, 2)["id"], "result": {}})  # a's turn runs

    # b sends into the same session: the core refuses it (-32602)…
    await chat_send(bridge, b_id, "s1", id=7)
    stub.emit({"id": forwarded_send(stub, b_id, 7)["id"], "error": {"code": -32602, "message": "a turn is running"}})
    assert b.received[-1] == {"jsonrpc": "2.0", "id": 7, "error": {"code": -32602, "message": "a turn is running"}}

    # …and a's turn keeps reaching a: tokens, the tool call, the edit and chat/done.
    stub.emit({"method": "chat/token", "params": {"sessionId": "s1", "delta": "x", "kind": "text"}})
    stub.emit({"method": "chat/toolCall", "params": {"sessionId": "s1", "toolCallId": "tc1", "name": "edit_file", "requiresApproval": True}})
    stub.emit(apply_edit(-1, "s1"))
    stub.emit({"method": "chat/done", "params": {"sessionId": "s1", "stopReason": "done"}})
    assert [m.get("method") for m in a.received if "method" in m] == [
        "chat/token",
        "chat/toolCall",
        "workspace/applyEdit",
        "chat/done",
    ]
    assert not [m for m in b.received if "method" in m], b.received

    # The turn is over: b's next send takes the session.
    await chat_send(bridge, b_id, "s1", id=8)
    stub.emit({"id": forwarded_send(stub, b_id, 8)["id"], "result": {}})
    stub.emit({"method": "chat/token", "params": {"sessionId": "s1", "delta": "y", "kind": "text"}})
    assert b.received[-1]["method"] == "chat/token"
    assert a.received[-1]["method"] == "chat/done"


async def test_send_adopts_a_running_session_whose_owner_left(bridge: Bridge, stub: StubCore) -> None:
    a_id, a = await connect(bridge)
    b_id, b = await connect(bridge)
    await chat_send(bridge, a_id, "s1", id=2)
    stub.emit({"id": forwarded_send(stub, a_id, 2)["id"], "result": {}})
    bridge.unregister(a_id)
    await chat_send(bridge, b_id, "s1", id=3)  # refused by the core, but the session is b's now
    stub.emit({"id": forwarded_send(stub, b_id, 3)["id"], "error": {"code": -32602, "message": "running"}})
    stub.emit({"method": "chat/done", "params": {"sessionId": "s1", "stopReason": "done"}})
    assert b.received[-1]["method"] == "chat/done"


async def test_racing_sends_leave_the_session_with_the_accepted_one(bridge: Bridge, stub: StubCore) -> None:
    a_id, a = await connect(bridge)
    b_id, b = await connect(bridge)
    # Both sends reach the bridge before either answer: b's (later) moves ownership…
    await chat_send(bridge, a_id, "s1", id=2)
    await chat_send(bridge, b_id, "s1", id=2)
    # …but the core accepted a's, so the turn and the session are a's.
    stub.emit({"id": forwarded_send(stub, a_id, 2)["id"], "result": {}})
    stub.emit({"id": forwarded_send(stub, b_id, 2)["id"], "error": {"code": -32602, "message": "running"}})
    stub.emit(apply_edit(-1, "s1"))
    assert a.received[-1]["method"] == "workspace/applyEdit"
    assert not [m for m in b.received if "method" in m]


async def test_a_turn_done_before_its_send_answer_is_not_left_running(bridge: Bridge, stub: StubCore) -> None:
    a_id, a = await connect(bridge)
    b_id, b = await connect(bridge)
    await chat_send(bridge, a_id, "s1", id=2)
    stub.emit({"method": "chat/done", "params": {"sessionId": "s1", "stopReason": "error"}})
    stub.emit({"id": forwarded_send(stub, a_id, 2)["id"], "result": {}})
    await chat_send(bridge, b_id, "s1", id=3)  # not running: b may take it
    stub.emit({"method": "chat/token", "params": {"sessionId": "s1", "delta": "z", "kind": "text"}})
    assert b.received[-1]["method"] == "chat/token"


async def test_apply_edit_routed_by_session_id(bridge: Bridge, stub: StubCore) -> None:
    a_id, a = await connect(bridge)
    b_id, b = await connect(bridge)
    await chat_send(bridge, a_id, "s1")
    await chat_send(bridge, b_id, "s2")
    # b approved last, yet each edit goes to the tab owning its session.
    stub.emit(apply_edit(-1, "s1"))
    stub.emit(apply_edit(-2, "s2"))
    assert [m["id"] for m in a.received if m.get("method") == "workspace/applyEdit"] == [-1]
    assert [m["id"] for m in b.received if m.get("method") == "workspace/applyEdit"] == [-2]


async def test_apply_edit_for_a_gone_owner_is_refused_never_sent_to_a_stranger(bridge: Bridge, stub: StubCore) -> None:
    a_id, a = await connect(bridge)
    b_id, b = await connect(bridge)
    await chat_send(bridge, a_id, "s1")
    bridge.unregister(a_id)
    stub.emit(apply_edit(-1, "s1"))
    stub.emit(apply_edit(-2, "never-sent"))
    stub.emit(apply_edit(-3, None))
    for id in (-1, -2, -3):
        reply = next(m for m in stub.sent if m.get("id") == id)
        assert reply["error"]["code"] == -32603, reply
    assert "owning tab disconnected" in next(m for m in stub.sent if m.get("id") == -1)["error"]["message"]
    assert not [m for m in b.received if m.get("method") == "workspace/applyEdit"]


async def test_pending_core_request_answered_with_error_when_tab_closes(bridge: Bridge, stub: StubCore) -> None:
    a_id, a = await connect(bridge)
    b_id, b = await connect(bridge)
    await chat_send(bridge, a_id, "s1")
    stub.emit(apply_edit(-1, "s1"))
    assert a.received[-1]["method"] == "workspace/applyEdit"

    bridge.unregister(a_id)
    error = next(m for m in stub.sent if m.get("id") == -1)
    assert error["error"]["code"] == -32603
    # b cannot answer a request that was never its own.
    await send(bridge, b_id, {"id": -1, "result": {"applied": True}})
    assert len([m for m in stub.sent if m.get("id") == -1]) == 1


async def test_completion_request_ids_are_namespaced_per_tab(bridge: Bridge, stub: StubCore) -> None:
    a_id, _ = await connect(bridge)
    b_id, _ = await connect(bridge)
    await send(bridge, a_id, {"id": 2, "method": "completion/request", "params": {"uri": "file:///a.py", "position": {"line": 0, "character": 0}, "requestId": "r1"}})
    for method in ("completion/cancel", "completion/accepted", "completion/rejected"):
        await send(bridge, b_id, {"method": method, "params": {"requestId": "r1"}})
    sent = {(m["method"], m["params"]["requestId"]) for m in stub.sent if m.get("method", "").startswith("completion/")}
    assert sent == {
        ("completion/request", f"{a_id}:r1"),
        ("completion/cancel", f"{b_id}:r1"),
        ("completion/accepted", f"{b_id}:r1"),
        ("completion/rejected", f"{b_id}:r1"),
    }


async def test_documents_are_refcounted_per_tab(bridge: Bridge, stub: StubCore) -> None:
    a_id, _ = await connect(bridge)
    b_id, _ = await connect(bridge)

    def doc(method: str, uri: str) -> dict:
        params: dict = {"uri": uri}
        if method == "textDocument/didOpen":
            params.update(languageId="python", version=1, text="x")
        if method == "textDocument/didChange":
            params.update(version=2, contentChanges=[{"text": "y"}])
        return {"method": method, "params": params}

    def doc_traffic() -> list[tuple[str, str]]:
        return [(m["method"].split("/")[1], m["params"]["uri"]) for m in stub.sent if m.get("method", "").startswith("textDocument/")]

    await send(bridge, a_id, doc("textDocument/didOpen", "file:///u.py"))
    second_open = doc("textDocument/didOpen", "file:///u.py")
    second_open["params"].update(version=5, text="b's text")
    await send(bridge, b_id, second_open)
    await send(bridge, b_id, doc("textDocument/didChange", "file:///u.py"))
    await send(bridge, a_id, doc("textDocument/didSave", "file:///u.py"))
    await send(bridge, a_id, doc("textDocument/didClose", "file:///u.py"))  # b still has it open
    await send(bridge, a_id, doc("textDocument/didOpen", "file:///v.py"))
    assert doc_traffic() == [
        ("didOpen", "file:///u.py"),
        ("didChange", "file:///u.py"),  # b's didOpen, as a full-text change
        ("didChange", "file:///u.py"),
        ("didSave", "file:///u.py"),
        ("didOpen", "file:///v.py"),
    ]
    # The second tab's text reaches the core: the overlay holds what that tab sees.
    assert stub.sent[1] == {
        "jsonrpc": "2.0",
        "method": "textDocument/didChange",
        "params": {"uri": "file:///u.py", "version": 5, "contentChanges": [{"text": "b's text"}]},
    }

    bridge.unregister(b_id)  # last holder of u
    bridge.unregister(a_id)  # last holder of v
    assert doc_traffic()[5:] == [("didClose", "file:///u.py"), ("didClose", "file:///v.py")]


async def test_pending_tool_call_replayed_to_the_tab_that_adopts_the_session(bridge: Bridge, stub: StubCore) -> None:
    a_id, a = await connect(bridge)
    b_id, b = await connect(bridge)
    await chat_send(bridge, a_id, "s1")
    call = {"method": "chat/toolCall", "params": {"sessionId": "s1", "toolCallId": "tc1", "name": "edit_file", "requiresApproval": True}}
    stub.emit(call)
    assert a.received[-1]["params"]["toolCallId"] == "tc1"
    bridge.unregister(a_id)
    later = {"method": "chat/toolCall", "params": {**call["params"], "toolCallId": "tc2"}}
    stub.emit(later)  # dropped while orphaned, but kept as the session's pending call
    assert not [m for m in b.received if m.get("method") == "chat/toolCall"]

    await send(bridge, b_id, {"id": 5, "method": "chat/history", "params": {"sessionId": "s1"}})
    forwarded = next(m for m in stub.sent if m.get("method") == "chat/history")
    stub.emit({"id": forwarded["id"], "result": {"sessionId": "s1", "messages": []}})
    # history first, then the call still awaiting approval
    assert [m.get("id", m.get("method")) for m in b.received] == [5, "chat/toolCall"]
    assert b.received[-1]["params"]["toolCallId"] == "tc2"

    stub.emit({"method": "chat/toolResult", "params": {"sessionId": "s1", "toolCallId": "tc2", "ok": True}})
    bridge.unregister(b_id)
    c_id, c = await connect(bridge)
    await send(bridge, c_id, {"id": 6, "method": "chat/history", "params": {"sessionId": "s1"}})
    forwarded = [m for m in stub.sent if m.get("method") == "chat/history"][-1]
    stub.emit({"id": forwarded["id"], "result": {"sessionId": "s1", "messages": []}})
    assert [m.get("id", m.get("method")) for m in c.received] == [6]  # nothing pending any more


async def test_apply_edit_without_any_tab_is_refused(bridge: Bridge, stub: StubCore) -> None:
    a_id, _ = await connect(bridge)
    await chat_send(bridge, a_id, "s1")
    bridge.unregister(a_id)
    stub.emit(apply_edit(-2, "s1"))
    assert next(m for m in stub.sent if m.get("id") == -2)["error"]["code"] == -32603


async def test_core_exit_fails_inflight_requests_and_closes_tabs(bridge: Bridge, stub: StubCore) -> None:
    a_id, a = await connect(bridge)
    await send(bridge, a_id, completion(4, 0))
    stub.exit(was_ready=True)
    assert a.received[-1]["id"] == 4 and a.received[-1]["error"]["code"] == -32603
    assert a.closed is not None and a.closed[0] == 1012


async def test_requests_fail_fast_when_core_not_running(bridge: Bridge, stub: StubCore) -> None:
    a_id, a = await connect(bridge)
    stub.state = "crashed"
    await send(bridge, a_id, completion(5, 0))
    assert a.received[-1]["id"] == 5 and a.received[-1]["error"]["code"] == -32603
    await send(bridge, a_id, {"id": 6, "method": "initialize", "params": {"settings": {}}})
    assert a.received[-1]["id"] == 6 and "crashed" in a.received[-1]["error"]["message"]
