import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { activate, deactivate, RESTART_DEBOUNCE_MS, type LocalPilotApi } from "../src/extension";
import { CoreClient } from "../src/rpc/coreClient";
import { waitFor } from "./helpers/webview";
import { configValues, editorEvents, registry, resetMock, Uri, workspace, workspaceConfigKeys, type MockStatusBarItem } from "./mocks/vscode";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const configChange = { affectsConfiguration: (s: string) => s === "localpilot" };

/** Fake-core processes launched for this test's workspace (its tmp dir is unique). */
function liveCores(): number {
  try {
    return execFileSync("pgrep", ["-f", `fakeCore.mjs serve --workspace ${dir}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}
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

    // Accepting a completion is a notification to the core (must not throw).
    registry.commands.get("localpilot.completionAccepted")!("7");

    // deactivate stops the core.
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

  it("overlapping_restarts_leave_exactly_one_core", async () => {
    const api = start();
    await api.ready;
    expect(liveCores()).toBe(1);
    // Restart Core twice while a debounced settings restart is also due.
    configValues["localpilot.completionMaxTokens"] = 40;
    editorEvents.configuration.fire(configChange);
    const r1 = registry.commands.get("localpilot.restartCore")!() as Promise<void>;
    const r2 = registry.commands.get("localpilot.restartCore")!() as Promise<void>;
    await Promise.all([r1, r2]);
    await sleep(RESTART_DEBOUNCE_MS + 100);
    await waitFor(() => api.client.state === "ready", 5000, "ready");
    await sleep(300); // let any stray launch show up
    expect(api.client.state).toBe("ready");
    expect(liveCores()).toBe(1);
    await deactivate();
    await waitFor(() => liveCores() === 0, 5000, "all cores gone");
  });

  it("client_only_settings_do_not_restart_core", async () => {
    const api = start();
    await api.ready;
    const states: string[] = [];
    api.client.onDidChangeState((s) => states.push(s));
    configValues["localpilot.completionsEnabled"] = false;
    configValues["localpilot.completionDebounceMs"] = 250;
    editorEvents.configuration.fire(configChange);
    await sleep(RESTART_DEBOUNCE_MS + 200);
    expect(states).toEqual([]);
    expect(item().text).toBe("$(debug-pause) completions paused");
  });

  it("toggle_writes_to_the_scope_that_defines_the_value", async () => {
    const api = start();
    await api.ready;
    configValues["localpilot.completionsEnabled"] = true;
    workspaceConfigKeys.add("localpilot.completionsEnabled");
    await registry.commands.get("localpilot.toggleCompletions")!();
    expect(registry.configUpdates).toEqual([{ key: "localpilot.completionsEnabled", value: false, target: 2 }]);
  });

  it("no_folder_window_has_no_dangling_status_command", () => {
    workspace.workspaceFolders = [];
    expect(activate(context as unknown as vscode.ExtensionContext)).toBeUndefined();
    expect(item().command).toBeUndefined();
    expect(registry.commands.size).toBe(0);
  });

  it("core_always_gets_completions_enabled_and_client_gates", async () => {
    const starts = vi.spyOn(CoreClient.prototype, "start");
    const restarts = vi.spyOn(CoreClient.prototype, "restart");
    try {
      configValues["localpilot.completionsEnabled"] = false;
      const api = start();
      await api.ready;
      // The user setting is off, but the core is told completions are on: gating is client-side.
      expect(starts.mock.calls[0][0].completionsEnabled).toBe(true);
      const states: string[] = [];
      api.client.onDidChangeState((s) => states.push(s));

      // Toggle on: no restart, and the running core serves completions.
      await registry.commands.get("localpilot.toggleCompletions")!();
      editorEvents.configuration.fire(configChange);
      await sleep(RESTART_DEBOUNCE_MS + 200);
      expect(states).toEqual([]);
      const result = await api.client.request<{ items: Array<{ text: string }> }>("completion/request", {
        uri: Uri.file(join(dir, "a.py")).toString(),
        position: { line: 0, character: 0 },
        requestId: "1",
      });
      expect(result.items.map((i) => i.text)).toEqual(["fake()"]);

      // A core-relevant change restarts, still with completionsEnabled forced on.
      configValues["localpilot.completionsEnabled"] = false;
      configValues["localpilot.completionMaxTokens"] = 20;
      editorEvents.configuration.fire(configChange);
      await waitFor(() => restarts.mock.calls.length === 1 && api.client.state === "ready" && states.includes("ready"), 5000, "restart");
      expect(restarts.mock.calls[0][0]).toMatchObject({ completionsEnabled: true, completionMaxTokens: 20 });
    } finally {
      starts.mockRestore();
      restarts.mockRestore();
    }
  });
});
