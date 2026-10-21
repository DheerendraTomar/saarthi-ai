"""LocalPilot for JupyterLab: a server extension that owns the localpilot-core process."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .app import LocalPilotApp

__version__ = "0.2.0"


def _jupyter_server_extension_points() -> list[dict[str, Any]]:
    return [{"module": "localpilot_jupyter", "app": LocalPilotApp}]


def _jupyter_labextension_paths() -> list[dict[str, str]]:
    # The prebuilt labextension (built by the JupyterLab extension build) lives here.
    if not (Path(__file__).parent / "labextension").is_dir():
        return []
    return [{"src": "labextension", "dest": "localpilot-jupyter"}]
