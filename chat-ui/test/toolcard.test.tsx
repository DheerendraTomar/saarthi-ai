import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { ToolCard } from "../src/components/ToolCard";
import { App } from "../src/components/App";
import { TestBridge } from "../src/host";
import type { HostToUi } from "../src/host";
import type { ChatToolCall, ChatToolResult } from "../src/protocol";

afterEach(cleanup);

const DIFF = ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n");

function editCall(over: Partial<ChatToolCall> = {}): ChatToolCall {
  return {
    sessionId: "s1",
    toolCallId: "t1",
    name: "edit_file",
    args: { path: "src/x.ts", old: "old", new: "new" },
    requiresApproval: true,
    preview: DIFF,
    ...over,
  };
}

function commandCall(): ChatToolCall {
  return {
    sessionId: "s1",
    toolCallId: "t2",
    name: "run_command",
    args: { command: "npm test", cwd: "pkg" },
    requiresApproval: true,
    preview: "npm test",
  };
}

const buttons = () => screen.queryAllByRole("button").map((b) => b.getAttribute("aria-label"));

describe("ToolCard", () => {
  it("approve_posts_decision_once", () => {
    const onDecision = vi.fn();
    const { container } = render(<ToolCard call={editCall()} onDecision={onDecision} />);
    // Name + args summary, and the preview as a diff (text, not HTML).
    expect(screen.getByText("edit_file")).toBeTruthy();
    expect(container.querySelector(".tool-args")?.textContent).toBe("src/x.ts");
    expect(container.querySelectorAll(".diff-line.add")).toHaveLength(1);
    expect(container.querySelectorAll(".diff-line.del")).toHaveLength(1);

    const approve = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith("once", undefined);
    // Buttons are gone after the decision; a pending state shows instead.
    expect(buttons()).not.toContain("Approve");
    expect(buttons()).not.toContain("Deny");
    expect(screen.getByText("Approved")).toBeTruthy();
  });

  it("always_posts_always", () => {
    const onDecision = vi.fn();
    render(<ToolCard call={editCall()} onDecision={onDecision} />);
    fireEvent.click(screen.getByRole("button", { name: "Always" }));
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith("always", undefined);
    expect(buttons()).not.toContain("Always");
  });

  it("edited_command_is_sent_as_editedArgs", () => {
    // Untouched command: no editedArgs (the core notes any edit to the model).
    const untouched = vi.fn();
    const first = render(<ToolCard call={commandCall()} onDecision={untouched} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(untouched).toHaveBeenCalledWith("once", undefined);
    first.unmount();

    // Edited command: the full args with the new command (the core replaces
    // the args object wholesale, so `cwd` must survive), also for "always".
    const onDecision = vi.fn();
    render(<ToolCard call={commandCall()} onDecision={onDecision} />);
    const input = screen.getByRole("textbox", { name: "Command" }) as HTMLInputElement;
    expect(input.value).toBe("npm test");
    fireEvent.input(input, { target: { value: "npm test -- --run" } });
    // Enter while editing must not approve (it would run the command).
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Always" }));
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith("always", { command: "npm test -- --run", cwd: "pkg" });
    // Locked after the decision.
    expect(input.readOnly).toBe(true);
  });

  it("deny_shows_denied_state", () => {
    const onDecision = vi.fn();
    const { container, rerender } = render(<ToolCard call={commandCall()} onDecision={onDecision} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecision).toHaveBeenCalledWith("deny", undefined);
    expect(buttons()).toEqual([]);
    expect(screen.getByText("Denied")).toBeTruthy();
    expect(container.querySelector(".tool-card.denied")).toBeTruthy();

    // The core's result replaces the pending label.
    const result: ChatToolResult = { sessionId: "s1", toolCallId: "t2", ok: false, summary: "Denied by user" };
    rerender(<ToolCard call={commandCall()} result={result} onDecision={onDecision} />);
    const res = container.querySelector(".tool-result-line") as HTMLElement;
    expect(res.classList.contains("err")).toBe(true);
    expect(res.textContent).toContain("Denied by user");
  });

  it("shows_result_without_buttons_and_renders_text_not_html", () => {
    const onDecision = vi.fn();
    const call = editCall({ preview: "+<img src=x onerror=alert(1)>", requiresApproval: true });
    const result: ChatToolResult = { sessionId: "s1", toolCallId: "t1", ok: true, summary: "Edited src/x.ts" };
    const { container } = render(<ToolCard call={call} result={result} onDecision={onDecision} />);
    expect(buttons()).toEqual([]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    const res = container.querySelector(".tool-result-line") as HTMLElement;
    expect(res.classList.contains("ok")).toBe(true);
    expect(res.textContent).toContain("Edited src/x.ts");

    // Auto-approved calls never show buttons.
    cleanup();
    render(<ToolCard call={{ ...editCall(), name: "read_file", args: { path: "a.ts" }, requiresApproval: false }} onDecision={onDecision} />);
    expect(buttons()).toEqual([]);
  });
});

describe("ToolCard in App", () => {
  it("posts_chat_approve_and_joins_result_into_card", () => {
    const bridge = new TestBridge();
    const { container } = render(<App bridge={bridge} />);
    const emit = (m: HostToUi) => act(() => bridge.emit(m));
    emit({ type: "session/list", sessions: [{ sessionId: "s1", title: "One", updatedAtMs: 1 }], current: "s1" });
    emit({ type: "chat/toolCall", ...commandCall() });
    fireEvent.input(screen.getByRole("textbox", { name: "Command" }), { target: { value: "ls" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(bridge.sent).toContainEqual({
      type: "chat/approve",
      toolCallId: "t2",
      decision: "once",
      editedArgs: { command: "ls", cwd: "pkg" },
    });
    emit({ type: "chat/toolResult", sessionId: "s1", toolCallId: "t2", ok: true, summary: "exit 0" });
    // The result is shown inside the card, not as a second row.
    expect(container.querySelectorAll(".tool-card")).toHaveLength(1);
    expect(container.querySelectorAll(".msg.tool-result")).toHaveLength(0);
    expect(container.querySelector(".tool-card .tool-result-line")?.textContent).toContain("exit 0");

    // A turn that ends without a result leaves no live buttons behind.
    emit({ type: "chat/toolCall", ...editCall({ toolCallId: "t3" }) });
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    emit({ type: "chat/done", sessionId: "s1", stopReason: "stopped" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("card_state_does_not_leak_across_sessions", () => {
    const bridge = new TestBridge();
    render(<App bridge={bridge} />);
    const emit = (m: HostToUi) => act(() => bridge.emit(m));
    emit({ type: "session/list", sessions: [], current: "s1" });
    emit({ type: "chat/toolCall", ...commandCall() });
    fireEvent.input(screen.getByRole("textbox", { name: "Command" }), { target: { value: "rm -rf build" } });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(screen.getByText("Denied")).toBeTruthy();

    // Another session whose first row is a call with the same id.
    emit({
      type: "session/history",
      sessionId: "s2",
      messages: [{ role: "assistant", content: "", toolCalls: [{ toolCallId: "t2", name: "run_command", args: { command: "ls" } }] }],
    });
    expect(screen.queryByText("Denied")).toBeNull();
    expect((screen.getByRole("textbox", { name: "Command" }) as HTMLInputElement).value).toBe("ls");
  });
});
