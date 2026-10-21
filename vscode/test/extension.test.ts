import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { activate, deactivate, RESTART_DEBOUNCE_MS, type LocalPilotApi } from "../src/extension";
import { waitFor } from "./helpers/webview";
import { configValues, editorEvents, registry, resetMock, Uri, workspace, type MockStatusBarItem } from "./mocks/vscode";

const extensionPath = dirname(dirname(fileURLToPath(import.meta.url)));
let dir: string;
let context: { subscriptions: Array<{ dispose(): unknown }>; extensionPath: string; extensionUri: Uri };
const savedEnv = { ...process.env };

beforeEach(() => {
  resetMock();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lp-ext-")));
  workspace.workspaceFolders = [{ uri: Uri.file(dir), name: "w", index: 0 }];
  workspace.textDocuments = [];
  workspace.notebookDocuments = [];
  process.env.LOCALPILOT_FAKE_CORE = "1";
  context = { subscriptions: [], extensionPath, extensionUri: Uri.file(extensionPath) };
});

afterEach(async () => {
  await deactivate();
  for (const d of context.subscriptions) d.dispose();
  process.env = { ...savedEnv };
  rmSync(dir, { recursive: true, force: true });
});

const start = () => activate(context as unknown as vscode.ExtensionContext) as LocalPilotApi;
const item = (): MockStatusBarItem => registry.statusBarItems[0];

describe("activate", () => {
  it("registers_everything_and_starts_the_core", async () => {
    const api = start();
    await api.ready;
    expect(api.client.state).toBe("ready");

    expect([...registry.commands.keys()].sort()).toEqual(
      [
        "localpilot.completionAccepted",
        "localpilot.newSession",
        "localpilot.openChat",
        "localpilot.pullModel",
        "localpilot.restartCore",
        "localpilot.startOllama",
        "localpilot.statusMenu",
        "localpilot.toggleCompletions",
      ].sort(),
    );
    expect(registry.inlineProviders.map((p) => p.selector)).toEqual([{ pattern: "**" }]);
    expect(registry.webviewViews.get("localpilot.chat")?.options).toEqual({ webviewOptions: { retainContextWhenHidden: true } });
    await waitFor(() => item().text === "$(sparkle) LocalPilot", 5000, "status bar ok");
    expect(item().command).toBe("localpilot.statusMenu");

    // Start Ollama opens one "Ollama" terminal running `ollama serve`.
    await registry.commands.get("localpilot.startOllama")!();
    await registry.commands.get("localpilot.startOllama")!();
    expect(registry.terminals.map((t) => [t.name, t.sent])).toEqual([["Ollama", ["ollama serve"]]]);

    // Open chat focuses the view.
    await registry.commands.get("localpilot.openChat")!();
    expect(registry.executed.map((e) => e.command)).toContain("localpilot.chat.focus");

    // Accepting a completion reports it to the core; the core answers applyEdit/runCommand requests.
    registry.commands.get("localpilot.completionAccepted")!("7");

    // The core still works after these, and deactivate stops it.
    await deactivate();
    expect(api.client.state).toBe("stopped");
  });

  it("status_bar_reflects_ollama_down_pull_and_paused", async () => {
    process.env.FAKE_OLLAMA = "down";
    configValues["localpilot.completionModel"] = "tiny-model:1b";
    const api = start();
    await api.ready;
    await waitFor(() => item().text === "$(warning) Ollama down", 5000, "down");
    api.statusBar.setPull(42);
    expect(item().text).toBe("$(cloud-download) Pulling 42%");
    api.statusBar.setPull(undefined);

    // Pull with model "" (what the chat UI sends) → the configured completion model, with progress.
    await registry.commands.get("localpilot.pullModel")!("");
    expect(registry.progress.length).toBeGreaterThan(0);
    expect(registry.messages).toContainEqual({ level: "info", message: "LocalPilot: tiny-model:1b is ready." });
    await waitFor(() => item().text === "$(sparkle) LocalPilot", 5000, "ok after pull");

    // Toggling completions pauses at once (and persists the setting).
    await registry.commands.get("localpilot.toggleCompletions")!();
    expect(registry.configUpdates).toEqual([{ key: "localpilot.completionsEnabled", value: false, target: 1 }]);
    api.statusBar.setStatus({ ollama: "ok", detail: "" });
    expect(item().text).toBe("$(debug-pause) completions paused");
  });

  it("settings_change_restarts_core_debounced", async () => {
    const api = start();
    await api.ready;
    const states: string[] = [];
    api.client.onDidChangeState((s) => states.push(s));
    const change = { affectsConfiguration: (s: string) => s === "localpilot" };
    configValues["localpilot.completionMaxTokens"] = 48;
    editorEvents.configuration.fire(change);
    editorEvents.configuration.fire(change);
    editorEvents.configuration.fire({ affectsConfiguration: () => false }); // unrelated: ignored
    await new Promise((r) => setTimeout(r, RESTART_DEBOUNCE_MS - 100));
    expect(states).toEqual([]);
    await waitFor(() => states.includes("ready"), 5000, "restart");
    // One restart for the burst of changes.
    expect(states).toEqual(["stopped", "starting", "ready"]);
  });
});
