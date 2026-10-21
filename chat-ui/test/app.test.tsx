import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { App } from "../src/components/App";
import { TestBridge } from "../src/host";
import type { HostToUi } from "../src/host";

afterEach(cleanup);

function setup() {
  const bridge = new TestBridge();
  const utils = render(<App bridge={bridge} />);
  const emit = (msg: HostToUi) => act(() => bridge.emit(msg));
  return { bridge, emit, ...utils };
}

describe("App", () => {
  it("app_applies_host_theme_variables", () => {
    const { emit } = setup();
    const root = document.documentElement.style;
    emit({ type: "ui/theme", vars: { "--vscode-foreground": "#111111", "--vscode-sideBar-background": "#fafafa" } });
    expect(root.getPropertyValue("--vscode-foreground")).toBe("#111111");
    expect(root.getPropertyValue("--vscode-sideBar-background")).toBe("#fafafa");
    // A later theme replaces values (dark → light switches).
    emit({ type: "ui/theme", vars: { "--vscode-foreground": "#eeeeee" } });
    expect(root.getPropertyValue("--vscode-foreground")).toBe("#eeeeee");
    root.removeProperty("--vscode-foreground");
    root.removeProperty("--vscode-sideBar-background");
  });

  it("app_renders_messages_and_sends_on_enter", () => {
    const { bridge, emit, container } = setup();
    expect(bridge.sent).toEqual([{ type: "ui/ready" }]);

    // Shift+Enter is a newline, not a send.
    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.input(input, { target: { value: "explain this" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(bridge.sent.filter((m) => m.type === "chat/send")).toHaveLength(0);

    // Enter sends, clears the box, and shows the user message.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(bridge.sent).toContainEqual({ type: "chat/send", message: "explain this", attachments: [] });
    expect(input.value).toBe("");
    expect(screen.getByText("explain this")).toBeTruthy();

    // Stop is visible while streaming and posts chat/stop.
    const stop = screen.getByRole("button", { name: "Stop" });
    emit({ type: "chat/token", sessionId: "s1", delta: "Use `x`", kind: "text" });
    emit({ type: "chat/token", sessionId: "s1", delta: "thinking hard", kind: "thinking" });
    expect(container.querySelector(".msg.assistant code")?.textContent).toBe("x");
    const details = container.querySelector("details.thinking") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("thinking hard");
    fireEvent.click(stop);
    expect(bridge.sent).toContainEqual({ type: "chat/stop" });

    emit({ type: "chat/done", sessionId: "s1", stopReason: "stopped" });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(container.querySelectorAll(".msg.assistant")).toHaveLength(1);

    // Error marks the assistant row.
    fireEvent.input(input, { target: { value: "again" } });
    fireEvent.keyDown(input, { key: "Enter" });
    emit({ type: "chat/done", sessionId: "s1", stopReason: "error" });
    expect(container.querySelectorAll(".msg.assistant.error")).toHaveLength(1);

    // Status pill: Ollama down → Start posts ollama/start.
    emit({ type: "status", ollama: "down", detail: "connection refused" });
    expect(screen.getByText("Ollama down")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start Ollama" }));
    expect(bridge.sent).toContainEqual({ type: "ollama/start" });

    // Model missing → Pull posts the model parsed from detail.
    emit({
      type: "status",
      ollama: "modelMissing",
      detail: 'model "qwen2.5-coder:0.5b-base" is not installed (run `ollama pull qwen2.5-coder:0.5b-base`)',
    });
    expect(screen.queryByRole("button", { name: "Start Ollama" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pull model" }));
    expect(bridge.sent).toContainEqual({ type: "ollama/pull", model: "qwen2.5-coder:0.5b-base" });

    // History replaces the rendered list.
    emit({ type: "session/history", sessionId: "s2", messages: [{ role: "user", content: "fresh" }] });
    expect(container.querySelectorAll(".msg")).toHaveLength(1);
    expect(screen.getByText("fresh")).toBeTruthy();
  });

  it("does_not_render_model_html", () => {
    const { emit, container } = setup();
    emit({ type: "chat/token", sessionId: "s1", delta: "<img src=x onerror=alert(1)>", kind: "text" });
    emit({ type: "chat/done", sessionId: "s1", stopReason: "done" });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("status pill", () => {
  it("shows_checking_until_status_then_recovers_from_failed_pull", () => {
    const { emit } = setup();
    expect(screen.getByText("Checking Ollama…")).toBeTruthy();
    emit({ type: "ollama/pullProgress", model: "m:1b", status: "pulling", completed: 1, total: 4 });
    expect(screen.getByText(/Pulling m:1b/)).toBeTruthy();
    emit({ type: "ui/error", message: "pull failed" });
    expect(screen.queryByText(/Pulling m:1b/)).toBeNull();
    emit({ type: "status", ollama: "modelMissing", detail: 'model "m:1b" is not installed' });
    expect(screen.getByRole("button", { name: "Pull model" })).toBeTruthy();
  });
});

describe("sessions", () => {
  it("session_switch_posts_switchSession_and_new_posts_newSession", () => {
    const { bridge, emit } = setup();
    emit({
      type: "session/list",
      sessions: [
        { sessionId: "s1", title: "Fix the build", updatedAtMs: 2 },
        { sessionId: "s2", title: "Explain parser", updatedAtMs: 1 },
      ],
      current: "s1",
    });
    const select = screen.getByRole("combobox", { name: "Session" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Fix the build", "Explain parser"]);
    expect(select.value).toBe("s1");

    fireEvent.change(select, { target: { value: "s2" } });
    expect(bridge.sent).toContainEqual({ type: "chat/switchSession", sessionId: "s2" });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(bridge.sent).toContainEqual({ type: "chat/newSession" });

    // No current session yet: a placeholder is selected, switching still works.
    emit({ type: "session/list", sessions: [{ sessionId: "s2", title: "Explain parser", updatedAtMs: 1 }], current: null });
    expect(select.value).toBe("");
    expect(select.options[0].textContent).toBe("New session");
  });
});

describe("code blocks", () => {
  it("copy_and_insert_post_raw_code", () => {
    const { bridge, emit } = setup();
    emit({ type: "chat/token", sessionId: "s1", delta: 'Try:\n\n```ts\nconst a = "<x>" && b;\n```\n', kind: "text" });
    emit({ type: "chat/done", sessionId: "s1", stopReason: "done" });
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(bridge.sent).toContainEqual({ type: "ui/copy", text: 'const a = "<x>" && b;' });
    fireEvent.click(screen.getByRole("button", { name: "Insert code at cursor" }));
    expect(bridge.sent).toContainEqual({ type: "ui/insertAtCursor", text: 'const a = "<x>" && b;' });
  });
});

describe("attachments", () => {
  it("attach_toggle_includes_active_file_and_selection", () => {
    const { bridge, emit } = setup();
    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    // No active file: no toggle.
    expect(screen.queryByRole("button", { name: /^Attach/ })).toBeNull();

    emit({ type: "ui/activeFile", uri: "file:///w/src/main.rs" });
    const toggle = screen.getByRole("button", { name: "Attach current file main.rs" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.input(input, { target: { value: "one" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(bridge.sent).toContainEqual({ type: "chat/send", message: "one", attachments: [{ uri: "file:///w/src/main.rs" }] });
    emit({ type: "chat/done", sessionId: "s1", stopReason: "done" });

    // A non-empty selection is attached as a range.
    const range = { start: { line: 1, character: 0 }, end: { line: 3, character: 4 } };
    emit({ type: "ui/activeFile", uri: "file:///w/src/lib.rs", selection: range });
    const selToggle = screen.getByRole("button", { name: "Attach selection lib.rs" });
    expect(selToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.input(input, { target: { value: "two" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(bridge.sent).toContainEqual({
      type: "chat/send",
      message: "two",
      attachments: [{ uri: "file:///w/src/lib.rs", range }],
    });
    emit({ type: "chat/done", sessionId: "s1", stopReason: "done" });

    // Toggled off → nothing attached.
    fireEvent.click(selToggle);
    fireEvent.input(input, { target: { value: "three" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(bridge.sent).toContainEqual({ type: "chat/send", message: "three", attachments: [] });
  });
});

describe("running turns and scrolling", () => {
  it("shows_stop_for_a_running_turn_reattached_after_history", () => {
    const { bridge, emit } = setup();
    emit({ type: "session/list", sessions: [{ sessionId: "s1", title: "t", updatedAtMs: 1 }], current: "s1" });
    emit({ type: "session/history", sessionId: "s1", messages: [{ role: "user", content: "edit it" }] });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    // The host reports the session's turn still runs: Stop shows although nothing streams.
    emit({ type: "chat/turnState", sessionId: "s1", running: true });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(bridge.sent).toContainEqual({ type: "chat/stop" });

    // And its re-posted approval is live again.
    emit({
      type: "chat/toolCall",
      sessionId: "s1",
      toolCallId: "t1",
      name: "run_command",
      args: { command: "ls" },
      requiresApproval: true,
      preview: "ls",
    });
    expect(screen.getByRole("button", { name: /deny/i })).toBeTruthy();
    emit({ type: "chat/done", sessionId: "s1", stopReason: "stopped" });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("auto_scrolls_only_while_the_user_is_at_the_bottom", () => {
    const { emit, container } = setup();
    const list = container.querySelector(".messages") as HTMLElement;
    let top = 0;
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 200 });
    Object.defineProperty(list, "scrollTop", { configurable: true, get: () => top, set: (v: number) => (top = v) });
    emit({ type: "session/list", sessions: [], current: "s1" });

    // At the bottom: new output keeps the newest line in view.
    top = 800;
    fireEvent.scroll(list);
    emit({ type: "chat/token", sessionId: "s1", delta: "one", kind: "text" });
    expect(top).toBe(1000);

    // Scrolled up to read: streaming does not yank the view back down.
    top = 100;
    fireEvent.scroll(list);
    emit({ type: "chat/token", sessionId: "s1", delta: " two", kind: "text" });
    expect(top).toBe(100);

    // Back near the bottom (within a few lines): sticking resumes.
    top = 780;
    fireEvent.scroll(list);
    emit({ type: "chat/token", sessionId: "s1", delta: " three", kind: "text" });
    expect(top).toBe(1000);
  });
});
