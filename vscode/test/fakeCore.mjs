#!/usr/bin/env node
// A stand-in for `localpilot-core serve` that speaks the LocalPilot protocol
// (newline-delimited JSON-RPC 2.0 on stdio) with scripted answers, so unit and
// e2e tests never need the real core or Ollama.
//
// Usage: node fakeCore.mjs [serve] [--workspace <dir>] [--log-level <lvl>]
//
// Environment:
//   FAKE_OLLAMA=ok|down|modelMissing  `initialize.ollamaStatus.ollama` (default ok)
//   FAKE_DELAY_MS=<n>                 delay before answering `completion/request` (default 0)
//   FAKE_CRASH_AFTER=<n>              on receiving the n-th request, exit(1) without answering it
//   FAKE_IGNORE_SHUTDOWN=1            answer `shutdown` but keep running (ignores stdin EOF too)
//
// Behaviour:
//   initialize          → { capabilities, ollamaStatus: { ollama, detail }, indexStatus: "building" },
//                          then an `index/ready { files, buildMs }` notification
//   completion/request  → { items: [{ text: "fake()", range: <empty range at params.position> }] }
//   chat/send           → {} then: chat/token ×2, chat/toolCall (edit_file, requiresApproval, diff
//                          preview), waits for chat/approve; on once/always sends the client a
//                          `workspace/applyEdit` request (id -1, -2, …) and reports its `applied`;
//                          on deny skips the edit; then chat/toolResult and chat/done { stopReason: "done" }
//   chat/approve, chat/stop → {} (chat/stop ends a waiting turn with stopReason "stopped")
//   chat/newSession     → { sessionId: "fake-session" }
//   ollama/status       → the same status as initialize
//   shutdown            → {} then exit 0
//   requests before initialize → -32600; unknown methods → -32601
//   notifications (textDocument/*, completion/cancel, …) are accepted silently
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

const DETAILS = {
  ok: "Ollama is running",
  down: "cannot reach Ollama at http://localhost:11434",
  modelMissing: "model qwen2.5-coder:0.5b-base is not pulled",
};
const ollamaStatus = { ollama: OLLAMA, detail: DETAILS[OLLAMA] ?? OLLAMA };

let initialized = false;
let requestCount = 0;
let nextServerId = -1;
const serverPending = new Map(); // id → resolve
const approvals = new Map(); // toolCallId → resolve(decision)

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

async function chatTurn(sessionId) {
  notify("chat/token", { sessionId, delta: "Sure, ", kind: "text" });
  notify("chat/token", { sessionId, delta: "editing a.py.", kind: "text" });
  const toolCallId = "fake-tool-1";
  const uri = pathToFileURL(join(workspace, "a.py")).href;
  notify("chat/toolCall", {
    sessionId,
    toolCallId,
    name: "edit_file",
    args: { path: "a.py", old: "", new: "fake()\n" },
    requiresApproval: true,
    preview: "--- a/a.py\n+++ b/a.py\n@@ -0,0 +1 @@\n+fake()\n",
  });
  const decision = await new Promise((resolve) => approvals.set(toolCallId, resolve));
  if (decision === "stopped") {
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
      respond(id, {
        capabilities: { completion: true, chat: true, bench: false },
        ollamaStatus,
        indexStatus: "building",
      });
      return notify("index/ready", { files: 1, buildMs: 1 });
    case "completion/request": {
      if (DELAY_MS > 0) await sleep(DELAY_MS);
      const pos = params?.position ?? { line: 0, character: 0 };
      return respond(id, { items: [{ text: "fake()", range: { start: pos, end: pos } }] });
    }
    case "chat/send":
      respond(id, {});
      return void chatTurn(params?.sessionId ?? "fake-session");
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
    case "chat/newSession":
      return respond(id, { sessionId: "fake-session" });
    case "ollama/status":
      return respond(id, ollamaStatus);
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
