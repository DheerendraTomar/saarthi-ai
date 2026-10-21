"""Owns the `localpilot-core serve` child process for one Jupyter server.

Newline-delimited JSON-RPC 2.0 over the child's stdio. The server sends
`initialize` itself (with the settings of the first client, stored for
restarts) and caches the result for later tabs. Every other stdout line is
handed to listeners verbatim. Unexpected exits are restarted at most
`max_restarts_per_minute` times within any 60 s window, then the state is
`crashed` until an explicit `start()`/`restart()`.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable, Literal, Mapping, Optional

CoreState = Literal["stopped", "starting", "ready", "crashed"]

#: Ids of the server's own requests; never collide with tab ids (`t<n>:<id>`).
SERVER_ID_PREFIX = "localpilot-server:"
RESTART_WINDOW_S = 60.0
#: StreamReader line limit; protocol lines (applyEdit, chat history) can be large.
LINE_LIMIT = 64 * 1024 * 1024


class CoreNotRunning(RuntimeError):
    """`send_line` while the core is stopped or crashed."""

    def __init__(self, state: str) -> None:
        super().__init__(f"LocalPilot core is not running (state: {state})")
        self.state = state


class CoreCrashed(RuntimeError):
    """The core could not be (re)started: spawn failure, refused initialize, or the restart limit was hit."""


class CoreStopped(RuntimeError):
    """The core was stopped while a caller waited for it to become ready."""


def _consume(fut: "asyncio.Future[Any]") -> None:
    if not fut.cancelled():
        fut.exception()


class CoreProcess:
    """One `localpilot-core serve --workspace <workspace> --log-level <log_level>` process."""

    def __init__(
        self,
        binary: Path,
        workspace: Path,
        log_level: str = "info",
        *,
        env: Optional[Mapping[str, str]] = None,
        max_restarts_per_minute: int = 3,
        shutdown_timeout: float = 2.0,
        log: Optional[logging.Logger] = None,
    ) -> None:
        self.binary = Path(binary)
        self.workspace = Path(workspace)
        self.log_level = log_level
        self.env = dict(env) if env is not None else None
        self.max_restarts_per_minute = max_restarts_per_minute
        self.shutdown_timeout = shutdown_timeout
        self.log = log or logging.getLogger("localpilot_jupyter")

        self.state: CoreState = "stopped"
        #: Settings sent with `initialize` (first client's; replaced by `restart(settings)`).
        self.settings: Optional[dict[str, Any]] = None
        #: Cached `initialize` result, kept current with `status` and `index/ready`.
        self.initialize_result: Optional[dict[str, Any]] = None
        #: Last Ollama status `{ollama, detail}` seen from the core, or None.
        self.ollama_status: Optional[dict[str, Any]] = None
        #: Processes launched so far (first start + restarts).
        self.launches = 0

        self._proc: Optional[asyncio.subprocess.Process] = None
        self._generation = 0
        self._ready_gen = 0  # generation that reached "ready" (0: none)
        self._index_ready_gen = 0
        self._ready: Optional[asyncio.Future[dict[str, Any]]] = None
        self._restarts: list[float] = []
        self._queue: list[str] = []
        self._stopping = False
        self._refused_gen = 0
        self._tasks: set[asyncio.Task[Any]] = set()
        self._watchers: dict[int, asyncio.Task[Any]] = {}
        self._listeners: list[Callable[[str], None]] = []
        self._state_listeners: list[Callable[[str], None]] = []
        self._exit_listeners: list[Callable[[bool], None]] = []

    # ------------------------------------------------------------------ listeners

    def add_listener(self, cb: Callable[[str], None]) -> Callable[[], None]:
        """`cb(line)` for every stdout line except responses to the server's own requests."""
        return self._add(self._listeners, cb)

    def add_state_listener(self, cb: Callable[[str], None]) -> Callable[[], None]:
        return self._add(self._state_listeners, cb)

    def add_exit_listener(self, cb: Callable[[bool], None]) -> Callable[[], None]:
        """`cb(was_ready)` whenever a core process exits (crash or stop)."""
        return self._add(self._exit_listeners, cb)

    @staticmethod
    def _add(lst: list[Any], cb: Any) -> Callable[[], None]:
        lst.append(cb)

        def remove() -> None:
            if cb in lst:
                lst.remove(cb)

        return remove

    def _fire(self, lst: list[Any], *args: Any) -> None:
        for cb in list(lst):
            try:
                cb(*args)
            except Exception:  # a listener must never break the reader
                self.log.exception("LocalPilot core listener failed")

    def _set_state(self, state: CoreState) -> None:
        if state != self.state:
            self.state = state
            self._fire(self._state_listeners, state)

    # ------------------------------------------------------------------ lifecycle

    async def start(self, settings: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        """Launches the core (if not running) and sends `initialize`; returns its (cached) result.

        While starting or ready this only waits for the current launch; `settings`
        are used only if none are stored yet. From stopped or crashed it launches
        anew with a fresh restart budget. Raises CoreCrashed / CoreStopped.
        """
        if self.settings is None and settings is not None:
            self.settings = settings
        if self.state in ("starting", "ready") and self._ready is not None:
            return await asyncio.shield(self._ready)
        self._restarts = []
        self._stopping = False
        self._new_ready_future()
        ready = self._ready
        assert ready is not None
        await self._launch()
        return await asyncio.shield(ready)

    async def restart(self, settings: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        """Stops the core and starts a fresh one, with new settings if given."""
        await self.stop()
        if settings is not None:
            self.settings = settings
        return await self.start()

    async def stop(self) -> None:
        """`shutdown`, stdin EOF, up to `shutdown_timeout` for a clean exit, then kill."""
        proc = self._proc
        self._stopping = True
        if proc is None:
            self._fail_ready(CoreStopped("LocalPilot core stopped"))
            self._set_state("stopped")
            return
        if proc.returncode is None and proc.stdin is not None:
            try:
                proc.stdin.write(self._encode({"id": SERVER_ID_PREFIX + "shutdown", "method": "shutdown"}))
                proc.stdin.close()
            except (BrokenPipeError, ConnectionResetError, RuntimeError):
                pass
        try:
            await asyncio.wait_for(asyncio.shield(proc.wait()), self.shutdown_timeout)
        except asyncio.TimeoutError:
            self.log.warning("LocalPilot core did not exit within %.1f s of shutdown; killing it", self.shutdown_timeout)
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        watcher = self._watchers.get(self._generation)
        if watcher is not None:
            await asyncio.shield(watcher)
        self._set_state("stopped")

    # ------------------------------------------------------------------ I/O

    def send_line(self, line: str) -> None:
        """Writes one JSON-RPC line. Queued while starting (the core drops pre-initialize
        notifications); raises CoreNotRunning when stopped or crashed."""
        if self.state == "starting":
            self._queue.append(line)
            return
        if self.state != "ready" or self._proc is None or self._proc.stdin is None:
            raise CoreNotRunning(self.state)
        self._write(self._proc, line.rstrip("\n") + "\n")

    def _write(self, proc: asyncio.subprocess.Process, data: str) -> None:
        try:
            assert proc.stdin is not None
            proc.stdin.write(data.encode("utf-8"))
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            pass  # the core died; its exit handler deals with it

    @staticmethod
    def _encode(msg: dict[str, Any]) -> bytes:
        return (json.dumps({"jsonrpc": "2.0", **msg}) + "\n").encode("utf-8")

    # ------------------------------------------------------------------ internals

    def _new_ready_future(self) -> None:
        if self._ready is None or self._ready.done():
            self._ready = asyncio.get_running_loop().create_future()
            self._ready.add_done_callback(_consume)

    def _fail_ready(self, err: Exception) -> None:
        if self._ready is not None and not self._ready.done():
            self._ready.set_exception(err)

    def _spawn_task(self, coro: Any) -> asyncio.Task[Any]:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def _launch(self) -> None:
        self.launches += 1
        self._generation += 1
        gen = self._generation
        self._queue = []
        self._set_state("starting")
        args = ["serve", "--workspace", str(self.workspace), "--log-level", self.log_level]
        try:
            proc = await asyncio.create_subprocess_exec(
                str(self.binary),
                *args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self.workspace),
                env=self.env,
                limit=LINE_LIMIT,
            )
        except OSError as err:
            # ENOENT / EACCES: the binary cannot be launched, so retrying is pointless.
            self.log.error("LocalPilot core could not be started (%s): %s", self.binary, err)
            self._set_state("crashed")
            self._fail_ready(CoreCrashed(f"LocalPilot core could not be started ({self.binary}): {err}"))
            return
        if gen != self._generation or self._stopping:  # stopped while spawning
            proc.kill()
        self._proc = proc
        self._watchers[gen] = self._spawn_task(self._watch(proc, gen))
        assert proc.stdin is not None
        proc.stdin.write(
            self._encode(
                {
                    "id": f"{SERVER_ID_PREFIX}initialize:{gen}",
                    "method": "initialize",
                    "params": {"workspaceRoot": str(self.workspace), "settings": self.settings or {}},
                }
            )
        )

    async def _watch(self, proc: asyncio.subprocess.Process, gen: int) -> None:
        stderr_task = self._spawn_task(self._drain_stderr(proc))
        assert proc.stdout is not None
        try:
            while True:
                try:
                    raw = await proc.stdout.readline()
                except ValueError:  # a line over LINE_LIMIT: skip what was buffered
                    self.log.warning("LocalPilot core sent an over-long line; dropped")
                    continue
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if line.strip():
                    self._on_line(line, gen)
            code = await proc.wait()
            await stderr_task
        finally:
            self._watchers.pop(gen, None)
        self._on_exit(proc, gen, code)

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> None:
        # Always drained, so a chatty core can never block on a full pipe.
        assert proc.stderr is not None
        while True:
            raw = await proc.stderr.readline()
            if not raw:
                return
            text = raw.decode("utf-8", errors="replace").rstrip()
            if text:
                self.log.debug("localpilot-core: %s", text)

    def _on_line(self, line: str, gen: int) -> None:
        try:
            msg = json.loads(line)
        except ValueError:
            self.log.warning("LocalPilot core sent a non-JSON line: %.200s", line)
            return
        if not isinstance(msg, dict):
            return
        msg_id = msg.get("id")
        if isinstance(msg_id, str) and msg_id.startswith(SERVER_ID_PREFIX):
            if msg_id == f"{SERVER_ID_PREFIX}initialize:{gen}":
                self._on_initialize(msg, gen)
            return
        method = msg.get("method")
        if method == "status" and isinstance(msg.get("params"), dict):
            self.ollama_status = msg["params"]
            if self.initialize_result is not None:
                self.initialize_result["ollamaStatus"] = msg["params"]
        elif method == "index/ready":
            self._index_ready_gen = gen
            if self.initialize_result is not None:
                self.initialize_result["indexStatus"] = "ready"
        self._fire(self._listeners, line)

    def _on_initialize(self, msg: dict[str, Any], gen: int) -> None:
        if gen != self._generation or self._proc is None:
            return
        if "error" in msg or not isinstance(msg.get("result"), dict):
            # The core is alive but refused to initialize: restarting would not help.
            self.log.error("LocalPilot core refused initialize: %s", msg.get("error"))
            self._refused_gen = gen
            self._set_state("crashed")
            self._fail_ready(CoreCrashed(f"LocalPilot core refused initialize: {msg.get('error')}"))
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass
            return
        result = copy.deepcopy(msg["result"])
        if self._index_ready_gen == gen:  # index/ready raced ahead of the response
            result["indexStatus"] = "ready"
        if isinstance(result.get("ollamaStatus"), dict):
            # The authoritative snapshot for this generation (the core sends `status` only on change).
            self.ollama_status = result["ollamaStatus"]
        self.initialize_result = result
        self._ready_gen = gen
        self._set_state("ready")
        queued, self._queue = self._queue, []
        for line in queued:
            self._write(self._proc, line.rstrip("\n") + "\n")
        if self._ready is not None and not self._ready.done():
            self._ready.set_result(result)

    def _on_exit(self, proc: asyncio.subprocess.Process, gen: int, code: Optional[int]) -> None:
        if gen != self._generation:
            return
        self._proc = None
        self._queue = []
        was_ready = self._ready_gen == gen
        self._fire(self._exit_listeners, was_ready)
        if self._stopping:
            self._fail_ready(CoreStopped("LocalPilot core stopped"))
            self._set_state("stopped")
            return
        if self._refused_gen == gen:
            return  # already crashed
        now = time.monotonic()
        self._restarts = [t for t in self._restarts if now - t < RESTART_WINDOW_S]
        if len(self._restarts) >= self.max_restarts_per_minute:
            self.log.error(
                "LocalPilot core crashed (exit code %s) after %d restarts within a minute; not restarting. "
                "See %s, then POST /localpilot/restart.",
                code,
                self.max_restarts_per_minute,
                self.workspace / ".localpilot" / "core.log",
            )
            self._set_state("crashed")
            self._fail_ready(CoreCrashed(f"LocalPilot core crashed (exit code {code}) and was restarted too often"))
            return
        self._restarts.append(now)
        self.log.warning(
            "LocalPilot core exited unexpectedly (exit code %s); restarting (%d/%d this minute)",
            code,
            len(self._restarts),
            self.max_restarts_per_minute,
        )
        self._new_ready_future()
        self._spawn_task(self._launch())
