#!/usr/bin/env node
// A stand-in for `localpilot-core serve` that speaks the LocalPilot protocol
// (newline-delimited JSON-RPC 2.0 on stdio) with scripted answers, so unit and
// e2e tests never need the real core or Ollama.
//
// Usage: node fakeCore.mjs [serve] [--workspace <dir>] [--log-level <lvl>]
//
// Environment (all optional):
//   FAKE_OLLAMA=ok|down|modelMissing  Ollama state (default ok). When not ok, completions return
//                                     `items: []` plus a `status` notification, and chat turns send
//                                     `status` then `chat/done { stopReason: "error" }` (like the real core)
//   FAKE_DELAY_MS=<n>                 delay before answering `completion/request` (default 0)
//   FAKE_CRASH_AFTER=<n>              on receiving the n-th request (initialize is #1), exit(1) without answering
//   FAKE_IGNORE_SHUTDOWN=1            answer `shutdown` but keep running (also ignores stdin EOF): a hung core
//   FAKE_INDEX_FIRST=1                send `index/ready` before the `initialize` response (a race the
//                                     README tells clients to handle)
//   FAKE_PULL_FAIL=1                  `ollama/pull` streams progress, then fails with RPC error -32000
//
// Behaviour:
//   initialize          → { capabilities, ollamaStatus: { ollama, detail }, indexStatus: "building" },
//                          plus `index/ready { files: 1, buildMs: 1 }` (after the response unless
//                          FAKE_INDEX_FIRST) and a `status` notification with the same Ollama status
//   completion/request  → { items: [{ text: "fake()", range: <empty range at params.position> }] }
//   chat/send           → {} then: chat/token ×2, chat/toolCall (edit_file, requiresApproval, diff
//                          preview), waits for chat/approve; on once/always sends the client a
//                          `workspace/applyEdit` request (id -1, -2, …) and reports its `applied`;
//                          on deny skips the edit; then chat/toolResult and chat/done { stopReason: "done" }.
//                          A second chat/send while that session's turn runs → -32602.
//   chat/approve        → {}            chat/stop → {} (ends a waiting turn with stopReason "stopped")
//   chat/newSession     → { sessionId: "fake-session-<n>" }
//   chat/listSessions   → { sessions: [{ sessionId, title, updatedAtMs }] } — a seeded "fake-session" plus
//                          every session created or chatted in, most recent first
//   chat/history        → { sessionId, messages } — the scripted turns of that session (user, assistant
//                          with toolCalls, tool, assistant); [] for an unknown session
//   ollama/status       → the current status
//   ollama/pull         → 3 `ollama/pullProgress` notifications then {} (status becomes ok, `status` sent);
//                          with FAKE_PULL_FAIL=1 → error -32000 after the progress
//   shutdown            → {} then exit 0
//   requests before initialize → -32600; unknown methods → -32601
//   notifications (textDocument/*, completion/cancel, …) are accepted silently; stdin EOF → exit 0
// Every received method is logged to stderr as `fake-core: <method>`.

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const argv = process.argv.slice(2);
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const workspace = argValue("--workspace") ?? process.cwd();

const OLLAMA = process.env.FAKE_OLLAMA ?? "ok";
const DELAY_MS = Number(process.env.FAKE_DELAY_MS ?? 0);
const CRASH_AFTER = process.env.FAKE_CRASH_AFTER ? Number(process.env.FAKE_CRASH_AFTER) : undefined;
const IGNORE_SHUTDOWN = process.env.FAKE_IGNORE_SHUTDOWN === "1";
const INDEX_FIRST = process.env.FAKE_INDEX_FIRST === "1";
const PULL_FAIL = process.env.FAKE_PULL_FAIL === "1";

const DETAILS = {
  ok: "Ollama is running",
  down: "cannot reach Ollama at http://localhost:11434",
  modelMissing: "model qwen2.5-coder:0.5b-base is not pulled",
};
let ollamaStatus = { ollama: OLLAMA, detail: DETAILS[OLLAMA] ?? OLLAMA };

let initialized = false;
let requestCount = 0;
let nextServerId = -1;
const serverPending = new Map(); // id → resolve
const approvals = new Map(); // toolCallId → resolve(decision)
const running = new Set(); // sessionIds with a turn in progress
let sessionCounter = 0;
let toolCallCounter = 0;
let clock = 1_700_000_000_000;
const sessions = new Map([["fake-session", { title: "Earlier chat", updatedAtMs: clock, messages: [] }]]);
const touchSession = (sessionId, title) => {
  let s = sessions.get(sessionId);
  if (!s) sessions.set(sessionId, (s = { title: title ?? "New chat", updatedAtMs: 0, messages: [] }));
  s.updatedAtMs = ++clock;
  return s;
};

const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const respond = (id, result) => write({ id, result });
const fail = (id, code, message) => write({ id, error: { code, message } });
const notify = (method, params) => write({ method, params });
const log = (text) => process.stderr.write(`fake-core: ${text}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requestClient(method, params) {
  const id = nextServerId--;
  write({ id, method, params });
  return new Promise((resolve) => serverPending.set(id, resolve));
}

async function chatTurn(sessionId, message) {
  const session = touchSession(sessionId);
  if (session.title === "New chat") session.title = String(message).slice(0, 40);
  session.messages.push({ role: "user", content: String(message) });
  if (ollamaStatus.ollama !== "ok") {
    notify("status", ollamaStatus);
    notify("chat/done", { sessionId, stopReason: "error" });
    return;
  }
  notify("chat/token", { sessionId, delta: "Sure, ", kind: "text" });
  notify("chat/token", { sessionId, delta: "editing a.py.", kind: "text" });
  const toolCallId = `fake-tool-${++toolCallCounter}`;
  const uri = pathToFileURL(join(workspace, "a.py")).href;
  const args = { path: "a.py", old: "", new: "fake()\n" };
  session.messages.push({
    role: "assistant",
    content: "Sure, editing a.py.",
    toolCalls: [{ toolCallId, name: "edit_file", args }],
  });
  notify("chat/toolCall", {
    sessionId,
    toolCallId,
    name: "edit_file",
    args,
    requiresApproval: true,
    preview: "--- a/a.py\n+++ b/a.py\n@@ -0,0 +1 @@\n+fake()\n",
  });
  const decision = await new Promise((resolve) => approvals.set(toolCallId, resolve));
  if (decision === "stopped") {
    session.messages.push({ role: "tool", toolCallId, content: "stopped" });
    notify("chat/done", { sessionId, stopReason: "stopped" });
    return;
  }
  let ok = false;
  let summary = "denied by user";
  if (decision !== "deny") {
    const zero = { line: 0, character: 0 };
    const res = await requestClient("workspace/applyEdit", {
      ops: [{ kind: "edit", uri, range: { start: zero, end: zero }, newText: "fake()\n" }],
      save: true,
    });
    ok = Boolean(res?.result?.applied);
    summary = ok ? "edited a.py" : `edit failed: ${res?.result?.error ?? res?.error?.message ?? "unknown"}`;
  }
  session.messages.push({ role: "tool", toolCallId, content: summary });
  session.messages.push({ role: "assistant", content: ok ? "Done." : "I left a.py unchanged." });
  notify("chat/toolResult", { sessionId, toolCallId, ok, summary });
  notify("chat/done", { sessionId, stopReason: "done" });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  requestCount += 1;
  if (CRASH_AFTER !== undefined && requestCount >= CRASH_AFTER) {
    log(`crashing on request ${requestCount} (${method})`);
    process.exit(1);
  }
  if (!initialized && method !== "initialize" && method !== "shutdown") {
    return fail(id, -32600, "not initialized");
  }
  switch (method) {
    case "initialize":
      if (initialized) return fail(id, -32600, "already initialized");
      initialized = true;
      if (INDEX_FIRST) notify("index/ready", { files: 1, buildMs: 1 });
      respond(id, {
        capabilities: { completion: true, chat: true, bench: false },
        ollamaStatus,
        indexStatus: "building",
      });
      if (!INDEX_FIRST) notify("index/ready", { files: 1, buildMs: 1 });
      return notify("status", ollamaStatus);
    case "completion/request": {
      if (DELAY_MS > 0) await sleep(DELAY_MS);
      if (ollamaStatus.ollama !== "ok") {
        // The real core never fails a completion: it answers empty and reports the status.
        respond(id, { items: [] });
        return notify("status", ollamaStatus);
      }
      const pos = params?.position ?? { line: 0, character: 0 };
      return respond(id, { items: [{ text: "fake()", range: { start: pos, end: pos } }] });
    }
    case "chat/send": {
      const sessionId = params?.sessionId ?? "fake-session";
      if (running.has(sessionId)) return fail(id, -32602, `a turn is already running in session ${sessionId}`);
      running.add(sessionId);
      respond(id, {});
      return void chatTurn(sessionId, params?.message ?? "").finally(() => running.delete(sessionId));
    }
    case "chat/approve": {
      respond(id, {});
      const resolve = approvals.get(params?.toolCallId);
      approvals.delete(params?.toolCallId);
      return resolve?.(params?.decision);
    }
    case "chat/stop":
      respond(id, {});
      for (const resolve of approvals.values()) resolve("stopped");
      return approvals.clear();
    case "chat/newSession": {
      const sessionId = `fake-session-${++sessionCounter}`;
      touchSession(sessionId, "New chat");
      return respond(id, { sessionId });
    }
    case "chat/listSessions":
      return respond(id, {
        sessions: [...sessions.entries()]
          .map(([sessionId, s]) => ({ sessionId, title: s.title, updatedAtMs: s.updatedAtMs }))
          .sort((a, b) => b.updatedAtMs - a.updatedAtMs),
      });
    case "chat/history":
      return respond(id, {
        sessionId: params?.sessionId,
        messages: sessions.get(params?.sessionId)?.messages ?? [],
      });
    case "ollama/status":
      return respond(id, ollamaStatus);
    case "ollama/pull": {
      const model = params?.model ?? "";
      notify("ollama/pullProgress", { model, status: "pulling manifest" });
      notify("ollama/pullProgress", { model, status: "downloading", completed: 50, total: 100 });
      notify("ollama/pullProgress", { model, status: "downloading", completed: 100, total: 100 });
      if (PULL_FAIL) return fail(id, -32000, `pull of ${model} failed: Ollama is not reachable`);
      respond(id, {});
      if (ollamaStatus.ollama !== "ok") {
        ollamaStatus = { ollama: "ok", detail: DETAILS.ok };
        notify("status", ollamaStatus);
      }
      return;
    }
    case "shutdown":
      respond(id, {});
      if (!IGNORE_SHUTDOWN) process.exit(0);
      return;
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ id: null, error: { code: -32700, message: "parse error" } });
  }
  if (typeof msg.method === "string") {
    log(msg.method);
    if (msg.id !== undefined && msg.id !== null) void handleRequest(msg);
    return;
  }
  // A response to one of our core→client requests.
  const resolve = serverPending.get(msg.id);
  serverPending.delete(msg.id);
  resolve?.(msg);
});
rl.on("close", () => {
  if (!IGNORE_SHUTDOWN) process.exit(0);
});
// A hung core: stay alive after stdin closes so the client has to kill us.
if (IGNORE_SHUTDOWN) setInterval(() => {}, 1 << 30);
