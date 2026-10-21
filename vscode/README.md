# LocalPilot for VS Code

Copilot-style inline completions and an agent chat, running entirely on your machine via Ollama.

## Keybinding

`Cmd+Shift+L` (macOS) / `Ctrl+Shift+L` opens the LocalPilot chat in any window with a folder open.
This shadows VS Code's default **Select All Occurrences of Find Match** on the same chord.
To get that back, open **Preferences: Open Keyboard Shortcuts**, search for `localpilot.openChat`,
and change or remove its binding (or rebind `editor.action.selectHighlights`).
