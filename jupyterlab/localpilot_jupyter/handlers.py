"""HTTP and WebSocket endpoints. All require Jupyter authentication."""

from __future__ import annotations

import json
from typing import Any, Optional

from jupyter_server.auth.decorator import ws_authenticated
from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.base.websocket import WebSocketMixin
from jupyter_server.utils import ensure_async
from tornado import web, websocket

from .bridge import Bridge

SETTINGS_KEY = "localpilot"


def _bridge(handler: web.RequestHandler) -> Bridge:
    return handler.settings[SETTINGS_KEY]


#: The agent runs shell commands and edits files through these endpoints, so they need the
#: same permission as a terminal.
AUTH_ACTION = "execute"
AUTH_RESOURCE = "terminals"


async def _authorize(handler: JupyterHandler) -> None:
    allowed = await ensure_async(
        handler.authorizer.is_authorized(handler, handler.current_user, AUTH_ACTION, AUTH_RESOURCE)
    )
    if not allowed:
        raise web.HTTPError(403, f"LocalPilot needs '{AUTH_ACTION}' permission on '{AUTH_RESOURCE}'")


class StatusHandler(APIHandler):
    """`GET /localpilot/status` → `{core: state, ollama: last status or null}`."""

    @web.authenticated
    def get(self) -> None:
        self.finish(json.dumps(_bridge(self).status()))


class RestartHandler(APIHandler):
    """`POST /localpilot/restart` (optional body `{settings}`) → restarts the core; returns the status."""

    @web.authenticated
    async def post(self) -> None:
        await _authorize(self)
        settings: Optional[dict[str, Any]] = None
        if self.request.body:
            try:
                body = json.loads(self.request.body)
            except ValueError as err:
                raise web.HTTPError(400, "body must be JSON") from err
            if isinstance(body, dict) and isinstance(body.get("settings"), dict):
                settings = body["settings"]
        try:
            status = await _bridge(self).restart(settings)
        except Exception as err:
            self.log.error("LocalPilot core restart failed: %s", err)
            self.set_status(500)
            self.finish(json.dumps({**_bridge(self).status(), "error": str(err)}))
            return
        self.finish(json.dumps(status))


class _Connection:
    def __init__(self, handler: "RpcWebSocket") -> None:
        self.handler = handler

    def send(self, text: str) -> None:
        # Raises WebSocketClosedError if already closed (the bridge catches it); a close
        # during the write fails the returned future, which is retrieved here so it is not logged.
        fut = self.handler.write_message(text)
        fut.add_done_callback(lambda f: f.cancelled() or f.exception())

    def close(self, code: Optional[int] = None, reason: Optional[str] = None) -> None:
        self.handler.close(code, reason)


class RpcWebSocket(WebSocketMixin, websocket.WebSocketHandler, JupyterHandler):  # type: ignore[misc]
    """`/localpilot/rpc`: one JSON-RPC message per text frame, bridged to the shared core."""

    tab_id: Optional[str] = None

    @ws_authenticated
    async def get(self, *args: Any, **kwargs: Any) -> None:
        await _authorize(self)
        await super().get(*args, **kwargs)

    def open(self, *args: Any, **kwargs: Any) -> None:
        super().open(*args, **kwargs)
        self.tab_id = _bridge(self).register(_Connection(self))
        self.log.debug("LocalPilot tab %s connected", self.tab_id)

    async def on_message(self, message: Any) -> None:
        if self.tab_id is None:
            return
        if isinstance(message, bytes):
            message = message.decode("utf-8", errors="replace")
        await _bridge(self).handle_from_tab(self.tab_id, message)

    def on_close(self) -> None:
        if self.tab_id is not None:
            _bridge(self).unregister(self.tab_id)
            self.log.debug("LocalPilot tab %s disconnected", self.tab_id)
            self.tab_id = None
