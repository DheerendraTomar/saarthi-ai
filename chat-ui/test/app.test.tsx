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
