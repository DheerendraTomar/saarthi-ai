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
  const response = (id: number) => waitFor((m) => m.id === id && !m.method);
  const call = async (method: string, params: unknown = {}) => response(send(method, params));
  const initialize = () => call("initialize", { workspaceRoot: here, settings: {} });
  return { msgs, send, waitFor, response, call, initialize };
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

  it("sessions_list_and_history_reflect_the_scripted_turn", async () => {
    const f = fake();
    await f.initialize();
    const { sessionId } = (await f.call("chat/newSession")).result as { sessionId: string };
    expect(sessionId).toMatch(/^fake-session-\d+$/);
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
});
