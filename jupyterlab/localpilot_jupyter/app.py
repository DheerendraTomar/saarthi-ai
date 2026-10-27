"""The Jupyter server extension: config, core binary resolution, handlers."""

from __future__ import annotations

import os
import platform
import sys
from pathlib import Path
from typing import Optional

from jupyter_server.extension.application import ExtensionApp
from traitlets import Unicode
from traitlets.config import Configurable

from .bridge import Bridge
from .core_process import CoreProcess
from .handlers import SETTINGS_KEY, OllamaCommandHandler, RestartHandler, RpcWebSocket, StatusHandler

BIN_DIR = Path(__file__).parent / "bin"


class CoreBinaryNotFound(RuntimeError):
    pass


def host_triple() -> str:
    machine = platform.machine().lower()
    arch = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64", "amd64": "x86_64"}.get(machine, machine)
    if sys.platform == "darwin":
        return f"{arch}-apple-darwin"
    if sys.platform == "win32":
        return f"{arch}-pc-windows-msvc"
    return f"{arch}-unknown-linux-gnu"


def resolve_core_binary(configured: Optional[str] = None, bin_dir: Path = BIN_DIR) -> Path:
    """`LOCALPILOT_CORE_BINARY` env → `c.LocalPilot.core_binary` → bundled `bin/<triple>/localpilot-core`."""
    for candidate in (os.environ.get("LOCALPILOT_CORE_BINARY"), configured):
        if candidate:
            return Path(candidate).expanduser()
    name = "localpilot-core.exe" if sys.platform == "win32" else "localpilot-core"
    bundled = bin_dir / host_triple() / name
    if bundled.is_file():
        return bundled
    raise CoreBinaryNotFound(
        f"LocalPilot core binary not found: set LOCALPILOT_CORE_BINARY or c.LocalPilot.core_binary "
        f"(no bundled binary at {bundled})"
    )


class LocalPilot(Configurable):
    """Configuration section `c.LocalPilot.*`."""

    core_binary = Unicode(
        "",
        config=True,
        help="Path of the localpilot-core binary (overridden by $LOCALPILOT_CORE_BINARY; "
        "default: the binary bundled in the package).",
    )
    core_log_level = Unicode(
        "info",
        config=True,
        help="--log-level passed to localpilot-core (error, warn, info, debug, trace or a tracing directive).",
    )


class LocalPilotApp(ExtensionApp):
    name = "localpilot_jupyter"

    def initialize_settings(self) -> None:
        config = LocalPilot(config=self.config)
        root_dir = Path(os.path.expanduser(self.serverapp.root_dir)).absolute()
        log = self.log

        def core_factory() -> CoreProcess:
            binary = resolve_core_binary(config.core_binary)
            log.info("LocalPilot: starting %s for %s", binary, root_dir)
            return CoreProcess(binary, root_dir, config.core_log_level, log=log)

        self.bridge = Bridge(core_factory, root_dir, log)
        self.settings[SETTINGS_KEY] = self.bridge

    def initialize_handlers(self) -> None:
        self.handlers.extend(
            [
                (r"/localpilot/status", StatusHandler),
                (r"/localpilot/restart", RestartHandler),
                (r"/localpilot/ollama-command", OllamaCommandHandler),
                (r"/localpilot/rpc", RpcWebSocket),
            ]
        )

    async def stop_extension(self) -> None:
        bridge = getattr(self, "bridge", None)
        if bridge is not None:
            await bridge.stop()
