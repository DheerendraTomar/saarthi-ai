import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../src/state";
import type { State, UiEvent } from "../src/state";
import type { HostToUi } from "../src/host";

function run(events: (HostToUi | UiEvent)[], from: State = initialState()): State {
  return events.reduce(reduce, from);
}

const tok = (delta: string, kind: "text" | "thinking" = "text"): HostToUi => ({
  type: "chat/token",
  sessionId: "s1",
  delta,
  kind,
});

describe("reduce", () => {
  it("tokens_accumulate_into_streaming_then_commit_on_done", () => {
    let s = run([{ type: "composer/send", text: "hi" }, tok("Hel"), tok("lo")]);
    expect(s.streaming).toEqual({ text: "Hello", thinking: "" });
    expect(s.messages).toEqual([{ kind: "user", text: "hi" }]);

    s = reduce(s, { type: "chat/done", sessionId: "s1", stopReason: "done" });
    expect(s.streaming).toBeNull();
    expect(s.messages).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "Hello" },
    ]);
  });

  it("thinking_tokens_go_to_thinking_buffer", () => {
    let s = run([tok("hmm", "thinking"), tok("...", "thinking"), tok("Answer")]);
    expect(s.streaming).toEqual({ text: "Answer", thinking: "hmm..." });
    s = reduce(s, { type: "chat/done", sessionId: "s1", stopReason: "done" });
    expect(s.messages).toEqual([{ kind: "assistant", text: "Answer", thinking: "hmm..." }]);
  });

  it("done_with_error_marks_last_assistant_errored", () => {
    // Partial output then error: the committed message is the errored one.
    let s = run([
      tok("partial"),
      { type: "chat/done", sessionId: "s1", stopReason: "error" },
    ]);
    expect(s.streaming).toBeNull();
    expect(s.messages).toEqual([{ kind: "assistant", text: "partial", error: true }]);

    // Error with no output at all: an empty errored assistant row is appended.
    s = run([
      { type: "composer/send", text: "q" },
      { type: "chat/done", sessionId: "s1", stopReason: "error" },
    ]);
    expect(s.messages).toEqual([
      { kind: "user", text: "q" },
      { kind: "assistant", text: "", error: true },
    ]);

    // contextFull: not an error, but a notice is shown.
    s = run([tok("x"), { type: "chat/done", sessionId: "s1", stopReason: "contextFull" }]);
    expect(s.messages).toEqual([{ kind: "assistant", text: "x" }]);
    expect(s.notice).toMatch(/context/i);
  });

  it("history_replaces_messages_on_switch", () => {
    let s = run([
      { type: "session/list", sessions: [{ sessionId: "s1", title: "One", updatedAtMs: 1 }], current: "s1" },
      { type: "composer/send", text: "old" },
      tok("streaming…"),
      {
        type: "chat/toolCall",
        sessionId: "s1",
        toolCallId: "t9",
        name: "run_command",
        args: { command: "ls" },
        requiresApproval: true,
      },
    ]);
    expect(s.pendingApprovals.has("t9")).toBe(true);

    s = reduce(s, {
      type: "session/history",
      sessionId: "s2",
      messages: [
        { role: "user", content: "read a.py" },
        {
          role: "assistant",
          content: "Reading.",
          thinking: "plan",
          toolCalls: [{ toolCallId: "t1", name: "read_file", args: { path: "a.py" } }],
        },
        { role: "tool", content: "print(1)", toolCallId: "t1" },
        { role: "assistant", content: "Done." },
      ],
    });
    expect(s.currentSessionId).toBe("s2");
    expect(s.streaming).toBeNull();
    expect(s.pendingApprovals.size).toBe(0);
    expect(s.sessions).toHaveLength(1); // list is kept
    expect(s.messages).toEqual([
      { kind: "user", text: "read a.py" },
      { kind: "assistant", text: "Reading.", thinking: "plan" },
      { kind: "toolCall", toolCallId: "t1", name: "read_file", args: { path: "a.py" }, requiresApproval: false },
      { kind: "toolResult", toolCallId: "t1", ok: true, summary: "print(1)" },
      { kind: "assistant", text: "Done." },
    ]);

    // Tokens from a session that is no longer current are ignored.
    const after = reduce(s, { type: "chat/token", sessionId: "s1", delta: "late", kind: "text" });
    expect(after.streaming).toBeNull();
  });

  it("handles_every_host_message_without_throwing", () => {
    const all: HostToUi[] = [
      tok("a"),
      {
        type: "chat/toolCall",
        sessionId: "s1",
        toolCallId: "t1",
        name: "edit_file",
        args: {},
        requiresApproval: true,
        preview: "--- a\n+++ b",
      },
      { type: "chat/toolResult", sessionId: "s1", toolCallId: "t1", ok: false, summary: "denied" },
      { type: "chat/done", sessionId: "s1", stopReason: "stopped" },
      { type: "status", ollama: "modelMissing", detail: 'model "m:1b" is not installed' },
      { type: "ollama/pullProgress", model: "m:1b", status: "pulling", completed: 5, total: 10 },
      { type: "session/list", sessions: [], current: null },
      { type: "session/history", sessionId: "s1", messages: [] },
      { type: "ui/activeFile", uri: "file:///a.py" },
      { type: "ui/error", message: "boom" },
    ];
    let s = initialState();
    const seen: State[] = [];
    for (const m of all) {
      s = reduce(s, m);
      seen.push(s);
    }
    // tool call committed the "a" buffer, then appended rows in order.
    expect(seen[2].messages.map((m) => m.kind)).toEqual(["assistant", "toolCall", "toolResult"]);
    expect(seen[1].pendingApprovals.get("t1")?.name).toBe("edit_file");
    expect(seen[2].pendingApprovals.size).toBe(0);
    expect(seen[4].status).toEqual({ ollama: "modelMissing", detail: 'model "m:1b" is not installed' });
    expect(seen[5].pull).toEqual({ model: "m:1b", status: "pulling", completed: 5, total: 10 });
    expect(seen[8].activeFile).toEqual({ uri: "file:///a.py" });
    expect(s.notice).toBe("boom");

    // A finished pull clears the progress.
    s = reduce(s, { type: "ollama/pullProgress", model: "m:1b", status: "success" });
    expect(s.pull).toBeUndefined();
  });
});
