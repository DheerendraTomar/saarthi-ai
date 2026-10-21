# Changelog

## 0.1.0 — 2026-10-21

First release.

- Inline (ghost text) completions from a local Ollama FIM model, in files and Jupyter notebook code cells; debounced, cancelled when superseded.
- Agent chat view (`Cmd+Shift+L`): streaming replies, sessions, file edits and terminal commands that run only after you approve them (Approve / Always / Deny).
- Bundled `localpilot-core` sidecar (macOS arm64), restarted on crash and when core settings change.
- Status bar with Ollama and core state; commands to start Ollama, pull models, toggle completions and restart the core.
