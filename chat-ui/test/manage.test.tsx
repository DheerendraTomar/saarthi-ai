// v2: model picker, settings panel, session deletion.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { App } from "../src/components/App";
import { TestBridge } from "../src/host";
import type { HostToUi } from "../src/host";
import type { CompletionStats, ModelInfo } from "../src/protocol";

afterEach(cleanup);

function setup() {
  const bridge = new TestBridge();
  const utils = render(<App bridge={bridge} />);
  const emit = (msg: HostToUi) => act(() => bridge.emit(msg));
  return { bridge, emit, ...utils };
}

const MODELS: ModelInfo[] = [
  { name: "qwen2.5-coder:7b", sizeBytes: 4_683_087_332, family: "qwen2", supportsInsert: true, supportsTools: true },
  { name: "llama3.2:3b", sizeBytes: 2_019_393_189, family: "llama", supportsInsert: false, supportsTools: true },
  { name: "qwen2.5-coder:0.5b-base", sizeBytes: 397_821_319, supportsInsert: true, supportsTools: false },
];

const CURRENT = { chat: "qwen2.5-coder:7b", completion: "qwen2.5-coder:0.5b-base" };

const SETTINGS = {
  completionModel: "qwen2.5-coder:0.5b-base",
  completionMaxTokens: 32,
  completionDebounceMs: 120,
  completionContextTokens: 2048,
  adaptiveCompletions: true,
};

function stats(served: number): CompletionStats {
  return {
    languages:
      served === 0
        ? {}
        : {
            python: {
              served,
              accepted: 10,
              partial: 0,
              rejected: served - 11,
              typedThrough: 1,
              acceptRate: 10 / served,
              learnedMaxLines: 4,
              learnedNumPredict: 24,
              learned: true,
              examples: 3,
            },
          },
    logPath: "/w/.localpilot/completions.jsonl",
    adaptive: true,
  };
}

/** Types into a number field and commits it like blur / Enter does (a native `change`). */
function commit(el: HTMLElement, value: string) {
  fireEvent.input(el, { target: { value } });
  act(() => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const SESSIONS = [
  { sessionId: "s1", title: "Fix the build", updatedAtMs: 3 },
  { sessionId: "s2", title: "Explain parser", updatedAtMs: 2 },
  { sessionId: "s3", title: "Add tests", updatedAtMs: 1 },
];

describe("model picker", () => {
  it("model_picker_lists_models_and_posts_select", () => {
    const { bridge, emit } = setup();
    // The first "Ollama ready" status asks for the list (once).
    emit({ type: "status", ollama: "ok", detail: "" });
    emit({ type: "status", ollama: "ok", detail: "" });
    expect(bridge.sent.filter((m) => m.type === "models/list")).toHaveLength(1);
    emit({ type: "models/list", models: MODELS, current: CURRENT, ollama: "ok" });
    const picker = screen.getByRole("combobox", { name: "Chat model" }) as HTMLSelectElement;
    const texts = [...picker.options].map((o) => o.textContent ?? "");
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("qwen2.5-coder:7b");
    expect(texts[0]).toContain("4.7 GB");
    expect(texts[2]).toContain("398 MB");
    // Chat picker: no-tools models are hinted; fill-in-the-middle is irrelevant here.
    expect(texts[2]).toContain("no tools");
    expect(texts[1]).not.toContain("fill-in-the-middle");
    expect(picker.value).toBe("qwen2.5-coder:7b");

    fireEvent.change(picker, { target: { value: "llama3.2:3b" } });
    expect(bridge.sent).toContainEqual({ type: "model/select", kind: "chat", name: "llama3.2:3b" });
    expect(picker.value).toBe("llama3.2:3b");
    // The host's next list is the truth: a rejected write does not stick.
    emit({ type: "models/list", models: MODELS, current: CURRENT, ollama: "ok" });
    expect(picker.value).toBe("qwen2.5-coder:7b");

    // The completion picker (settings panel) warns about no-FIM models but keeps them selectable.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const completion = screen.getByRole("combobox", { name: "Completion model" }) as HTMLSelectElement;
    const llama = [...completion.options].find((o) => o.value === "llama3.2:3b") as HTMLOptionElement;
    expect(llama.textContent).toContain("no fill-in-the-middle");
    expect(llama.disabled).toBe(false);
    expect(completion.value).toBe("qwen2.5-coder:0.5b-base");
    fireEvent.change(completion, { target: { value: "llama3.2:3b" } });
    expect(bridge.sent).toContainEqual({ type: "model/select", kind: "completion", name: "llama3.2:3b" });
    expect(screen.getByText(/does not support fill-in-the-middle/)).toBeTruthy();

    // A configured model that is not installed is shown as such, not silently dropped.
    emit({ type: "models/list", models: MODELS, current: { ...CURRENT, chat: "gone:1b" }, ollama: "ok" });
    const chat = screen.getByRole("combobox", { name: "Chat model" }) as HTMLSelectElement;
    expect(chat.value).toBe("gone:1b");
    expect(chat.selectedOptions[0].textContent).toContain("not installed");
  });

  it("model_missing_status_requests_models", () => {
    const { bridge, emit } = setup();
    // Fresh install, configured model not pulled: the picker is the way out, so load it.
    emit({ type: "status", ollama: "modelMissing", detail: 'model "m:1b" is not installed' });
    expect(bridge.sent.filter((m) => m.type === "models/list")).toHaveLength(1);
    // Still missing: no repeat. Down: nothing to ask. Back up: ask again.
    emit({ type: "status", ollama: "modelMissing", detail: 'model "m:1b" is not installed' });
    emit({ type: "status", ollama: "down", detail: "refused" });
    expect(bridge.sent.filter((m) => m.type === "models/list")).toHaveLength(1);
    emit({ type: "status", ollama: "ok", detail: "" });
    expect(bridge.sent.filter((m) => m.type === "models/list")).toHaveLength(2);
  });

  it("model_picker_shows_ollama_down_state", () => {
    const { bridge, emit, container } = setup();
    // Nothing known yet and Ollama down: a clear state, never an empty silent picker.
    emit({ type: "models/list", models: [], current: CURRENT, ollama: "down", error: "connection refused" });
    expect(screen.queryByRole("combobox", { name: "Chat model" })).toBeNull();
    const down = container.querySelector(".model-picker.down") as HTMLElement;
    expect(down.textContent).toContain("Ollama down");
    expect(down.getAttribute("title")).toContain("connection refused");

    // An empty list with an error is the same unavailable state even if `ollama` says ok.
    emit({ type: "models/list", models: [], current: CURRENT, ollama: "ok", error: "bad response" });
    expect(container.querySelector(".model-picker.down")).toBeTruthy();

    // The header does not repeat "Ollama down" next to the status pill; Settings still shows it.
    emit({ type: "status", ollama: "down", detail: "refused" });
    expect(container.querySelector(".header .model-picker.down")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(container.querySelector(".settings-panel .model-picker.down")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    // Once the list is known, a later down report keeps the last-known list, marked stale.
    emit({ type: "models/list", models: MODELS, current: CURRENT, ollama: "ok" });
    emit({ type: "models/list", models: [], current: CURRENT, ollama: "down" });
    const picker = screen.getByRole("combobox", { name: "Chat model" }) as HTMLSelectElement;
    expect(picker.options).toHaveLength(3);
    expect(picker.getAttribute("title")).toContain("Ollama down");
    expect(container.querySelector(".model-picker.stale")).toBeTruthy();

    // Ollama coming back (status ok) re-requests the list.
    emit({ type: "status", ollama: "down", detail: "refused" });
    const before = bridge.sent.filter((m) => m.type === "models/list").length;
    emit({ type: "status", ollama: "ok", detail: "" });
    expect(bridge.sent.filter((m) => m.type === "models/list").length).toBe(before + 1);
  });
});

describe("settings panel", () => {
  it("settings_panel_edits_post_patch_and_show_stats", () => {
    const { bridge, emit } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    // Opening asks the host for everything the panel shows.
    expect(bridge.sent).toContainEqual({ type: "settings/get" });
    expect(bridge.sent).toContainEqual({ type: "completion/stats" });
    expect(bridge.sent).toContainEqual({ type: "models/list" });

    emit({ type: "settings/current", settings: SETTINGS });
    emit({ type: "models/list", models: MODELS, current: CURRENT, ollama: "ok" });
    emit({ type: "completion/stats", stats: stats(31) });

    const maxTokens = screen.getByLabelText("Max tokens") as HTMLInputElement;
    expect(maxTokens.value).toBe("32");
    // Typing alone posts nothing; the commit (blur / Enter) does.
    fireEvent.input(maxTokens, { target: { value: "4" } });
    expect(bridge.sent.filter((m) => m.type === "settings/set")).toHaveLength(0);
    commit(maxTokens, "48");
    expect(bridge.sent).toContainEqual({ type: "settings/set", patch: { completionMaxTokens: 48 } });

    commit(screen.getByLabelText("Debounce (ms)"), "200");
    expect(bridge.sent).toContainEqual({ type: "settings/set", patch: { completionDebounceMs: 200 } });
    const context = screen.getByLabelText("Context budget (tokens)") as HTMLInputElement;
    commit(context, "4096");
    expect(bridge.sent).toContainEqual({ type: "settings/set", patch: { completionContextTokens: 4096 } });
    // Below the host's 256-token floor: not posted, reverts.
    expect(context.min).toBe("256");
    commit(context, "100");
    expect(bridge.sent).not.toContainEqual({ type: "settings/set", patch: { completionContextTokens: 100 } });
    expect(context.value).toBe("2048");

    const adaptive = screen.getByLabelText("Adaptive completions") as HTMLInputElement;
    expect(adaptive.checked).toBe(true);
    fireEvent.click(adaptive);
    expect(bridge.sent).toContainEqual({ type: "settings/set", patch: { adaptiveCompletions: false } });

    // Invalid input is not posted and reverts.
    const posted = bridge.sent.length;
    commit(maxTokens, "-3");
    commit(maxTokens, "2.5");
    commit(maxTokens, "");
    expect(bridge.sent.length).toBe(posted);
    expect(maxTokens.value).toBe("32");

    // A committed value the host did not apply is reset by the next settings/current, even if unchanged.
    commit(maxTokens, "64");
    expect(maxTokens.value).toBe("64");
    emit({ type: "settings/current", settings: SETTINGS });
    expect(maxTokens.value).toBe("32");

    // Stats per language.
    const table = screen.getByRole("table", { name: "Completion stats" });
    const headers = [...table.querySelectorAll("th")].map((c) => c.textContent);
    expect(headers).toEqual([
      "Language",
      "Served",
      "Accepted",
      "Partial",
      "Typed",
      "Rejected",
      "Accept rate (incl. partial)",
      "Lines",
      "Tokens",
      "Examples",
    ]);
    const row = within(table).getByText("python").closest("tr") as HTMLTableRowElement;
    const cells = [...row.cells].map((c) => c.textContent);
    expect(cells).toEqual(["python", "31", "10", "0", "1", "20", "32%", "4 (learned)", "24 (learned)", "3"]);
    expect(screen.getByText("/w/.localpilot/completions.jsonl")).toBeTruthy();

    // Closing hides it.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByLabelText("Max tokens")).toBeNull();
  });

  it("reset_learning_posts_and_refreshes_stats", () => {
    const { bridge, emit } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    emit({ type: "settings/current", settings: SETTINGS });
    emit({ type: "completion/stats", stats: stats(31) });
    bridge.sent.length = 0;

    // First click only asks; the second click on the same button resets.
    const reset = screen.getByRole("button", { name: "Reset learning" });
    fireEvent.click(reset);
    expect(bridge.sent).toEqual([]);
    expect(screen.getByText("Reset learning?")).toBeTruthy();
    expect(reset.textContent).toBe("Confirm");
    fireEvent.click(reset);
    expect(bridge.sent).toEqual([{ type: "completion/resetLearning" }, { type: "completion/stats" }]);

    emit({ type: "completion/stats", stats: stats(0) });
    expect(screen.queryByText("python")).toBeNull();
    expect(screen.getByText("No completions recorded yet.")).toBeTruthy();
    // Back to the unarmed state.
    expect(screen.getByRole("button", { name: "Reset learning" })).toBeTruthy();
    expect(screen.queryByText("Reset learning?")).toBeNull();
  });

  it("stats_tag_lines_and_tokens_learned_or_default", () => {
    const { emit } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const cellsOf = () => {
      const table = screen.getByRole("table", { name: "Completion stats" });
      const row = within(table).getByText("python").closest("tr") as HTMLTableRowElement;
      return [...row.cells].slice(7, 9).map((c) => c.textContent);
    };
    const base = stats(31);
    // Too few outcomes: the core reports the configured values as not learned.
    const few = { ...base.languages.python, learned: false, learnedMaxLines: 8, learnedNumPredict: 32 };
    emit({ type: "completion/stats", stats: { ...base, languages: { python: few } } });
    expect(cellsOf()).toEqual(["8 (default)", "32 (default)"]);
    // Adaptive off: defaults, whatever the core says about the language.
    emit({ type: "completion/stats", stats: { ...base, adaptive: false } });
    expect(cellsOf()).toEqual(["4 (default)", "24 (default)"]);
    emit({ type: "completion/stats", stats: base });
    expect(cellsOf()).toEqual(["4 (learned)", "24 (learned)"]);
  });
});

describe("session deletion", () => {
  function openSessions(emit: (m: HostToUi) => void, current = "s1") {
    emit({ type: "session/list", sessions: SESSIONS, current });
    emit({ type: "session/history", sessionId: current, messages: [{ role: "user", content: `history of ${current}` }] });
    fireEvent.click(screen.getByRole("button", { name: "Manage sessions" }));
    return screen.getByRole("list", { name: "Sessions" });
  }

  it("session_delete_posts_and_switches_to_next", () => {
    const { bridge, emit } = setup();
    const list = openSessions(emit);
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);

    // Deleting another session: posted; when confirmed it is just dropped.
    fireEvent.click(within(list).getByRole("button", { name: 'Delete session "Explain parser"' }));
    expect(bridge.sent).toContainEqual({ type: "session/delete", sessionId: "s2" });
    emit({ type: "session/deleted", sessionId: "s2", next: "s1" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("history of s1")).toBeTruthy();
    expect(bridge.sent.filter((m) => m.type === "chat/switchSession")).toHaveLength(0);

    // Deleting the current one: dropped, view cleared, switches to `next`.
    fireEvent.click(within(list).getByRole("button", { name: 'Delete session "Fix the build"' }));
    expect(bridge.sent).toContainEqual({ type: "session/delete", sessionId: "s1" });
    emit({ type: "session/deleted", sessionId: "s1", next: "s3" });
    expect(bridge.sent).toContainEqual({ type: "chat/switchSession", sessionId: "s3" });
    expect(screen.queryByText("history of s1")).toBeNull();
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);

    // Deleting the last one: no next → a new session.
    emit({ type: "session/history", sessionId: "s3", messages: [] });
    emit({ type: "session/deleted", sessionId: "s3", next: null });
    expect(bridge.sent).toContainEqual({ type: "chat/newSession" });
    expect(screen.getByText("No sessions yet.")).toBeTruthy();

    // Clicking a row switches to it.
    emit({ type: "session/list", sessions: SESSIONS, current: "s1" });
    fireEvent.click(screen.getByRole("button", { name: "Add tests" }));
    expect(bridge.sent).toContainEqual({ type: "chat/switchSession", sessionId: "s3" });
  });

  it("clear_all_requires_confirm", () => {
    const { bridge, emit } = setup();
    openSessions(emit);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(bridge.sent.filter((m) => m.type === "session/clearAll")).toHaveLength(0);
    expect(screen.getByRole("group", { name: "Confirm clear all" }).textContent).toContain("Delete all sessions?");
    // Focus moves into the confirm step (the safe choice)…
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    // Cancel backs out without posting, and focus returns to "Clear all".
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Delete all sessions?")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Clear all" }));
    expect(bridge.sent.filter((m) => m.type === "session/clearAll")).toHaveLength(0);

    // Confirm posts once.
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect(bridge.sent.filter((m) => m.type === "session/clearAll")).toHaveLength(1);
    expect(screen.queryByText("Delete all sessions?")).toBeNull();
  });

  it("delete_disabled_for_running_session_with_reason", () => {
    const { bridge, emit } = setup();
    const list = openSessions(emit);
    emit({ type: "chat/turnState", sessionId: "s1", running: true });

    const running = within(list).getByRole("button", { name: 'Delete session "Fix the build"' }) as HTMLButtonElement;
    // aria-disabled, not disabled: still focusable, so the reason is reachable by keyboard.
    expect(running.getAttribute("aria-disabled")).toBe("true");
    expect(running.disabled).toBe(false);
    expect(running.getAttribute("title")).toMatch(/turn is running/);
    // The reason is visible too, not only in a tooltip.
    const row = running.closest("li") as HTMLElement;
    expect(within(row).getByText(/Running/)).toBeTruthy();
    fireEvent.click(running);
    expect(bridge.sent.filter((m) => m.type === "session/delete")).toHaveLength(0);

    // Other sessions stay deletable during the turn.
    const other = within(list).getByRole("button", { name: 'Delete session "Explain parser"' }) as HTMLButtonElement;
    expect(other.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(other);
    expect(bridge.sent).toContainEqual({ type: "session/delete", sessionId: "s2" });

    // When the turn ends, the current session is deletable again.
    emit({ type: "chat/done", sessionId: "s1", stopReason: "done" });
    expect(running.getAttribute("aria-disabled")).toBeNull();
  });
});
