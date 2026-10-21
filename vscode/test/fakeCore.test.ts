// Drives fakeCore.mjs over raw stdio to pin the behaviours Tasks 6–7 rely on.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { lineSplitter } from "../src/rpc/coreClient";

const here = dirname(fileURLToPath(import.meta.url));
type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };

const procs: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});

/** Spawns the fake; auto-answers core→client requests with `{ applied: true }`. */
function fake(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [join(here, "fakeCore.mjs"), "serve", "--workspace", here], {
    env: { ...process.env, ...env },
  });
  procs.push(child);
  const msgs: Msg[] = [];
  const waiters = new Set<() => void>();
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on(
    "data",
    lineSplitter((line) => {
      if (!line) return;
      const m = JSON.parse(line) as Msg;
      msgs.push(m);
      if (m.method && typeof m.id === "number" && m.id < 0) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { applied: true } }) + "\n");
      }
      for (const w of [...waiters]) w();
    }),
  );
  let nextId = 1;
  const send = (method: string, params: unknown = {}) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return id;
  };
  /** Resolves with the first message (index into `msgs`) matching `pred`. */
  const waitFor = (pred: (m: Msg) => boolean) =>
    new Promise<Msg>((resolve) => {
      const check = () => {
        const m = msgs.find(pred);
        if (m) {
          waiters.delete(check);
          resolve(m);
        }
      };
      waiters.add(check);
      check();
    });
  const notify = (method: string, params: unknown = {}) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const response = (id: number) => waitFor((m) => m.id === id && !m.method);
  const call = async (method: string, params: unknown = {}) => response(send(method, params));
  const initialize = () => call("initialize", { workspaceRoot: here, settings: {} });
  return { msgs, send, notify, waitFor, response, call, initialize };
}

const methodsOf = (msgs: Msg[]) => msgs.map((m) => m.method ?? `#${m.id}`);

describe("fakeCore", () => {
  it("initialize_sends_index_ready_and_status_in_either_order", async () => {
    const normal = fake();
    await normal.initialize();
    await normal.waitFor((m) => m.method === "status");
    expect(methodsOf(normal.msgs)).toEqual(["#1", "index/ready", "status"]);
    expect(normal.msgs[2].params).toEqual({ ollama: "ok", detail: expect.any(String) });

    const first = fake({ FAKE_INDEX_FIRST: "1" });
    await first.initialize();
    await first.waitFor((m) => m.method === "status");
    expect(methodsOf(first.msgs)).toEqual(["index/ready", "#1", "status"]);
  });

  it("rejects_requests_before_initialize_and_unknown_methods", async () => {
    const f = fake();
    expect((await f.call("ollama/status")).error?.code).toBe(-32600);
    await f.initialize();
    expect((await f.call("bench/run")).error?.code).toBe(-32601);
  });

  it.each(["down", "modelMissing"])("ollama_%s_empties_completions_and_errors_chat", async (state) => {
    const f = fake({ FAKE_OLLAMA: state });
    await f.initialize();
    const before = f.msgs.length;
    const res = await f.call("completion/request", { uri: "file:///a.py", position: { line: 0, character: 0 }, requestId: "r" });
    expect(res.result).toEqual({ items: [] });
    await f.waitFor((m) => m.method === "status" && f.msgs.indexOf(m) > before);
    expect((await f.call("chat/send", { sessionId: "s", message: "hi", attachments: [] })).result).toEqual({});
    const done = await f.waitFor((m) => m.method === "chat/done");
    expect(done.params).toEqual({ sessionId: "s", stopReason: "error" });
    const tail = methodsOf(f.msgs.slice(f.msgs.findIndex((m) => m.method === "chat/done") - 1));
    expect(tail).toEqual(["status", "chat/done"]);
    expect(f.msgs.some((m) => m.method === "chat/token")).toBe(false);
  });

  it("second_chat_send_while_turn_runs_is_invalid_params", async () => {
    const f = fake();
    await f.initialize();
    const send = { sessionId: "s", message: "hi", attachments: [] };
    expect((await f.call("chat/send", send)).result).toEqual({});
    expect((await f.call("chat/send", send)).error?.code).toBe(-32602);
    // Another session is independent.
    expect((await f.call("chat/send", { ...send, sessionId: "other" })).result).toEqual({});
    // Once the turn ends, the session accepts a new message.
    const call = (await f.waitFor((m) => m.method === "chat/toolCall" && m.params?.sessionId === "s")).params!;
    await f.call("chat/approve", { sessionId: "s", toolCallId: call.toolCallId, decision: "deny" });
    await f.waitFor((m) => m.method === "chat/done" && m.params?.sessionId === "s");
    expect((await f.call("chat/send", send)).result).toEqual({});
  });

  it("stop_ends_only_the_given_sessions_turn_and_new_session_ids_are_unique_across_cores", async () => {
    const f = fake();
    await f.initialize();
    const send = (sessionId: string) => f.call("chat/send", { sessionId, message: "hi", attachments: [] });
    await send("a");
    await send("b");
    await f.waitFor((m) => m.method === "chat/toolCall" && m.params?.sessionId === "a");
    const callB = (await f.waitFor((m) => m.method === "chat/toolCall" && m.params?.sessionId === "b")).params!;

    await f.call("chat/stop", { sessionId: "a" });
    expect((await f.waitFor((m) => m.method === "chat/done" && m.params?.sessionId === "a")).params?.stopReason).toBe("stopped");
    // b still waits for its approval.
    expect(f.msgs.some((m) => m.method === "chat/done" && m.params?.sessionId === "b")).toBe(false);
    await f.call("chat/approve", { sessionId: "b", toolCallId: callB.toolCallId, decision: "deny" });
    expect((await f.waitFor((m) => m.method === "chat/done" && m.params?.sessionId === "b")).params?.stopReason).toBe("done");

    // A restarted core (a new process) never hands out an id the previous one did.
    const g = fake();
    await g.initialize();
    const id1 = ((await f.call("chat/newSession")).result as { sessionId: string }).sessionId;
    const id2 = ((await g.call("chat/newSession")).result as { sessionId: string }).sessionId;
    expect(id1).not.toBe(id2);
  });

  it("sessions_list_and_history_reflect_the_scripted_turn", async () => {
    const f = fake();
    await f.initialize();
    const { sessionId } = (await f.call("chat/newSession")).result as { sessionId: string };
    expect(sessionId).toMatch(/^fake-session-\d+-\d+$/);
    await f.call("chat/send", { sessionId, message: "add a call", attachments: [] });
    const call = (await f.waitFor((m) => m.method === "chat/toolCall")).params!;
    await f.call("chat/approve", { sessionId, toolCallId: call.toolCallId, decision: "once" });
    const result = await f.waitFor((m) => m.method === "chat/toolResult");
    expect(result.params).toMatchObject({ ok: true });
    await f.waitFor((m) => m.method === "chat/done");

    const list = (await f.call("chat/listSessions")).result as { sessions: Array<{ sessionId: string; title: string; updatedAtMs: number }> };
    expect(list.sessions.map((s) => s.sessionId)).toEqual([sessionId, "fake-session"]);
    expect(list.sessions[0].title).toBe("add a call");

    const history = (await f.call("chat/history", { sessionId })).result as { sessionId: string; messages: Array<Record<string, unknown>> };
    expect(history.sessionId).toBe(sessionId);
    expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(history.messages[1].toolCalls).toEqual([{ toolCallId: call.toolCallId, name: "edit_file", args: call.args }]);
    expect(history.messages[2]).toMatchObject({ toolCallId: call.toolCallId });
    expect(((await f.call("chat/history", { sessionId: "nope" })).result as { messages: unknown[] }).messages).toEqual([]);
  });

  it("pull_streams_progress_then_resolves_or_fails", async () => {
    const ok = fake({ FAKE_OLLAMA: "modelMissing" });
    await ok.initialize();
    const res = await ok.call("ollama/pull", { model: "m" });
    expect(res.result).toEqual({});
    const progress = ok.msgs.filter((m) => m.method === "ollama/pullProgress");
    expect(progress).toHaveLength(3);
    expect(progress.every((m) => m.params?.model === "m")).toBe(true);
    expect(ok.msgs.indexOf(progress[2])).toBeLessThan(ok.msgs.indexOf(res));
    // The model is now present: status flips to ok.
    await ok.waitFor((m) => m.method === "status" && (m.params as { ollama: string }).ollama === "ok");

    const bad = fake({ FAKE_PULL_FAIL: "1" });
    await bad.initialize();
    const err = await bad.call("ollama/pull", { model: "m" });
    expect(err.error?.code).toBe(-32000);
    expect(bad.msgs.filter((m) => m.method === "ollama/pullProgress")).toHaveLength(3);
  });

  it("v2_models_session_deletion_and_stats", async () => {
    const f = fake();
    await f.initialize();
    const models = (await f.call("ollama/models")).result as { models: Array<{ name: string; supportsInsert: boolean }> };
    expect(models.models.map((m) => [m.name, m.supportsInsert])).toEqual([
      ["qwen2.5-coder:0.5b-base", true],
      ["qwen3.8:27b-mlx", false],
    ]);

    // A running session cannot be deleted; clearSessions keeps it and reports it.
    const send = { sessionId: "busy", message: "hi", attachments: [] };
    await f.call("chat/send", send);
    await f.waitFor((m) => m.method === "chat/toolCall" && m.params?.sessionId === "busy");
    expect((await f.call("chat/deleteSession", { sessionId: "busy" })).error?.code).toBe(-32602);
    expect((await f.call("chat/deleteSession", { sessionId: "fake-session" })).result).toEqual({});
    const { sessionId } = (await f.call("chat/newSession")).result as { sessionId: string };
    expect((await f.call("chat/clearSessions")).result).toEqual({ deleted: 1, skipped: ["busy"] });
    const list = (await f.call("chat/listSessions")).result as { sessions: Array<{ sessionId: string }> };
    expect(list.sessions.map((s) => s.sessionId)).toEqual(["busy"]);
    expect(sessionId).not.toBe("busy");

    // Outcome notifications feed completion/stats; resetLearning zeroes them.
    f.notify("completion/outcome", { requestId: "1", outcome: "partial", acceptedText: "x" });
    f.notify("completion/rejected", { requestId: "2" });
    const stats = (await f.call("completion/stats")).result as { languages: Record<string, { served: number; partial: number }>; adaptive: boolean; logPath: string };
    expect(stats.adaptive).toBe(true);
    expect(stats.languages.typescript).toMatchObject({ served: 2, partial: 1, rejected: 1, acceptRate: 0.5 });
    expect(stats.logPath).toMatch(/\.localpilot\/completions\.jsonl$/);
    expect(await f.call("completion/resetLearning")).toMatchObject({ result: {} });
    expect(((await f.call("completion/stats")).result as { languages: object }).languages).toEqual({});
  });

  it("v2_ollama_models_fails_when_ollama_is_down", async () => {
    const f = fake({ FAKE_OLLAMA: "down" });
    await f.initialize();
    const r = await f.call("ollama/models");
    expect(r.error).toEqual({ code: -32000, message: "cannot reach Ollama at http://localhost:11434" });
  });
});
