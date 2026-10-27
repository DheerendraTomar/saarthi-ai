import { describe, expect, it } from "vitest";
import { initialState, isSessionRunning, reduce } from "../src/state";
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
    expect(seen[7].activeFile).toEqual({ uri: "file:///a.py" });
    expect(s.notice).toBe("boom");
  });
});

describe("reattaching to a running turn", () => {
  const history: HostToUi = {
    type: "session/history",
    sessionId: "s1",
    messages: [
      { role: "user", content: "edit a.py" },
      { role: "assistant", content: "Sure.", toolCalls: [{ toolCallId: "t1", name: "edit_file", args: { path: "a.py" } }] },
    ],
  };
  const pendingCall: HostToUi = {
    type: "chat/toolCall",
    sessionId: "s1",
    toolCallId: "t1",
    name: "edit_file",
    args: { path: "a.py" },
    requiresApproval: true,
    preview: "--- a/a.py\n+++ b/a.py",
  };

  it("turnState_running_shows_stop_without_streaming_and_not_running_ends_it", () => {
    let s = run([history]);
    expect(s.streaming).toBeNull();
    s = reduce(s, { type: "chat/turnState", sessionId: "s1", running: true });
    // An empty buffer: the composer shows Stop, nothing is rendered as a reply yet.
    expect(s.streaming).toEqual({ text: "", thinking: "" });
    // Tokens keep streaming into it.
    s = reduce(s, tok("more"));
    s = reduce(s, { type: "chat/turnState", sessionId: "s1", running: true });
    expect(s.streaming).toEqual({ text: "more", thinking: "" });
    s = reduce(s, { type: "chat/turnState", sessionId: "s1", running: false });
    expect(s.streaming).toBeNull();
    expect(s.messages[s.messages.length - 1]).toEqual({ kind: "assistant", text: "more" });
    // Another session's turn state is ignored.
    s = reduce(s, { type: "chat/turnState", sessionId: "other", running: true });
    expect(s.streaming).toBeNull();
  });

  it("reposted_tool_call_after_history_becomes_pending_without_duplicating_the_row", () => {
    let s = run([history, pendingCall]);
    const calls = s.messages.filter((m) => m.kind === "toolCall");
    expect(calls).toEqual([
      { kind: "toolCall", toolCallId: "t1", name: "edit_file", args: { path: "a.py" }, requiresApproval: true, preview: "--- a/a.py\n+++ b/a.py" },
    ]);
    expect(s.messages.map((m) => m.kind)).toEqual(["user", "assistant", "toolCall"]);
    expect(s.pendingApprovals.get("t1")?.preview).toBe("--- a/a.py\n+++ b/a.py");
    expect(s.streaming).toEqual({ text: "", thinking: "" });

    // A call that history does not have yet is appended as usual.
    s = reduce(s, { ...pendingCall, toolCallId: "t2" });
    expect(s.messages.filter((m) => m.kind === "toolCall").map((m) => (m as { toolCallId: string }).toolCallId)).toEqual(["t1", "t2"]);
  });
});

describe("status lifecycle", () => {
  it("initial_status_is_unknown_until_host_reports", () => {
    expect(initialState().status.ollama).toBe("unknown");
  });

  it("running_sessions_tracked_across_sessions", () => {
    const list: HostToUi = {
      type: "session/list",
      sessions: [
        { sessionId: "s1", title: "a", updatedAtMs: 2 },
        { sessionId: "s2", title: "b", updatedAtMs: 1 },
      ],
      current: "s1",
    };
    // A turn started in s1, then the user switched to s2: s1 still counts as running.
    let s = run([list, { type: "composer/send", text: "go" }, { type: "session/history", sessionId: "s2", messages: [] }]);
    expect(s.currentSessionId).toBe("s2");
    expect(isSessionRunning(s, "s1")).toBe(true);
    expect(isSessionRunning(s, "s2")).toBe(false);
    // Its chat/done (another session's turn event) still clears it.
    s = run([{ type: "chat/done", sessionId: "s1", stopReason: "done" }], s);
    expect(isSessionRunning(s, "s1")).toBe(false);
    s = run([{ type: "chat/turnState", sessionId: "s1", running: true }], s);
    expect(isSessionRunning(s, "s1")).toBe(true);
    s = run([{ type: "chat/turnState", sessionId: "s1", running: false }], s);
    expect(isSessionRunning(s, "s1")).toBe(false);
  });

  it("session_deleted_drops_it_and_clears_the_view_only_when_current", () => {
    const list: HostToUi = {
      type: "session/list",
      sessions: [
        { sessionId: "s1", title: "a", updatedAtMs: 2 },
        { sessionId: "s2", title: "b", updatedAtMs: 1 },
      ],
      current: "s1",
    };
    let s = run([list, { type: "session/history", sessionId: "s1", messages: [{ role: "user", content: "x" }] }]);
    s = run([{ type: "session/deleted", sessionId: "s2", next: "s1" }], s);
    expect(s.sessions.map((x) => x.sessionId)).toEqual(["s1"]);
    expect(s.messages).toHaveLength(1);
    s = run([{ type: "session/deleted", sessionId: "s1", next: null }], s);
    expect(s.sessions).toEqual([]);
    expect(s.currentSessionId).toBeNull();
    expect(s.messages).toEqual([]);
  });
});
