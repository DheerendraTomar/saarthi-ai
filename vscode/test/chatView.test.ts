import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatViewProvider, renderHtml } from "../src/chat/chatView";
import { CoreClient } from "../src/rpc/coreClient";
import { DEFAULT_SETTINGS } from "../src/settings";
import { fakeWebviewView, FakeChatClient, waitFor } from "./helpers/webview";
import { Uri, resetMock, workspace } from "./mocks/vscode";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = "/work/proj";

const TEMPLATE =
  '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>LocalPilot</title>\n' +
  '    <script type="module" crossorigin>console.log("ui")</script>\n    <style rel="stylesheet" crossorigin>body{}</style>\n' +
  '  </head>\n  <body><div id="app"></div></body>\n</html>\n';

const SESSIONS = [
  { sessionId: "s2", title: "Latest", updatedAtMs: 2 },
  { sessionId: "s1", title: "Older", updatedAtMs: 1 },
];
const HISTORY = [{ role: "user", content: "earlier question" }];

const startOllamaCalls: number[] = [];
const pulls: string[] = [];

const chatActivity: boolean[] = [];

function makeProvider(client: unknown) {
  return new ChatViewProvider(client as ConstructorParameters<typeof ChatViewProvider>[0], {
    extensionUri: Uri.file("/ext") as never,
    root: ROOT,
    html: () => TEMPLATE,
    startOllama: () => void startOllamaCalls.push(1),
    pullModel: async (model) => void pulls.push(model),
    onChatActiveChanged: (active) => void chatActivity.push(active),
  });
}

function defaultResponder(method: string, params: unknown): unknown {
  switch (method) {
    case "chat/listSessions":
      return { sessions: SESSIONS };
    case "chat/history":
      return { sessionId: (params as { sessionId: string }).sessionId, messages: HISTORY };
    case "chat/newSession":
      return { sessionId: "s3" };
    default:
      return {};
  }
}

const types = (posted: Array<Record<string, unknown>>) => posted.map((m) => m.type);

const providers: ChatViewProvider[] = [];
const clients: CoreClient[] = [];

beforeEach(() => {
  resetMock();
  workspace.workspaceFolders = [{ uri: Uri.file(ROOT), name: "proj", index: 0 }];
  startOllamaCalls.length = 0;
  pulls.length = 0;
  chatActivity.length = 0;
});

afterEach(async () => {
  for (const p of providers.splice(0)) p.dispose();
  await Promise.all(clients.splice(0).map((c) => c.stop()));
});

describe("renderHtml", () => {
  it("injects_csp_meta_and_nonce", () => {
    const html = renderHtml(TEMPLATE, "vscode-resource:", "abc123");
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' vscode-resource:; ` +
        `script-src 'nonce-abc123'; img-src vscode-resource: data:">`,
    );
    // The CSP comes before the script, and the only script carries the nonce.
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script"));
    expect(html).toContain('<script nonce="abc123" type="module" crossorigin>console.log("ui")</script>');
    expect(html.match(/<script/g)).toHaveLength(1);
  });
});

describe("ChatViewProvider", () => {
  it("chatView_relays_send_with_current_session_and_forwards_tokens", async () => {
    const client = new FakeChatClient(defaultResponder);
    const provider = makeProvider(client);
    providers.push(provider);
    provider.setStatus({ ollama: "ok", detail: "Ollama is running" });
    const ui = fakeWebviewView();
    provider.resolveWebviewView(ui.view);

    // Webview setup: scripts on, resources limited to the extension, CSP + nonce in the html.
    expect(ui.webview.options).toEqual({ enableScripts: true, localResourceRoots: [Uri.file("/ext")] });
    const nonce = /script-src 'nonce-([^']+)'/.exec(ui.webview.html)?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]{16,}$/);
    expect(ui.webview.html).toContain(`<script nonce="${nonce}"`);

    // ui/ready → session list first, then the current session's history, then the status.
    ui.send({ type: "ui/ready" });
    await waitFor(() => ui.posted.length >= 4, 5000, "ready replies");
    expect(ui.posted.slice(0, 4)).toEqual([
      { type: "session/list", sessions: SESSIONS, current: "s2" },
      { type: "session/history", sessionId: "s2", messages: HISTORY },
      { type: "chat/turnState", sessionId: "s2", running: false },
      { type: "status", ollama: "ok", detail: "Ollama is running" },
    ]);
    expect(client.of("chat/history")).toEqual([{ sessionId: "s2" }]);

    // chat/send carries the current session.
    const attachments = [{ uri: "file:///work/proj/a.py", range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } } }];
    ui.send({ type: "chat/send", message: "fix it", attachments });
    await waitFor(() => client.of("chat/send").length === 1, 5000, "chat/send");
    expect(client.of("chat/send")).toEqual([{ sessionId: "s2", message: "fix it", attachments }]);

    // Core notifications reach the webview flattened as { type: <method>, ...params }.
    ui.posted.length = 0;
    client.emit("chat/token", { sessionId: "s2", delta: "Hel", kind: "text" });
    client.emit("chat/token", { sessionId: "s2", delta: "lo", kind: "text" });
    client.emit("chat/toolCall", { sessionId: "s2", toolCallId: "t1", name: "read_file", args: { path: "a.py" }, requiresApproval: false });
    client.emit("chat/toolResult", { sessionId: "s2", toolCallId: "t1", ok: true, summary: "read a.py" });
    client.emit("status", { ollama: "down", detail: "gone" });
    client.emit("ollama/pullProgress", { model: "m", status: "pulling", completed: 1, total: 2 });
    client.emit("chat/done", { sessionId: "s2", stopReason: "done" });
    expect(ui.posted.slice(0, 7)).toEqual([
      { type: "chat/token", sessionId: "s2", delta: "Hel", kind: "text" },
      { type: "chat/token", sessionId: "s2", delta: "lo", kind: "text" },
      { type: "chat/toolCall", sessionId: "s2", toolCallId: "t1", name: "read_file", args: { path: "a.py" }, requiresApproval: false },
      { type: "chat/toolResult", sessionId: "s2", toolCallId: "t1", ok: true, summary: "read a.py" },
      { type: "status", ollama: "down", detail: "gone" },
      { type: "ollama/pullProgress", model: "m", status: "pulling", completed: 1, total: 2 },
      { type: "chat/done", sessionId: "s2", stopReason: "done" },
    ]);

    // chat/stop targets the current session; ollama buttons go to the commands.
    ui.send({ type: "chat/stop" });
    ui.send({ type: "ollama/start" });
    ui.send({ type: "ollama/pull", model: "qwen2.5-coder:1.5b-base" });
    await waitFor(() => client.of("chat/stop").length === 1 && pulls.length === 1, 5000, "stop + pull");
    expect(client.of("chat/stop")).toEqual([{ sessionId: "s2" }]);
    expect(startOllamaCalls).toHaveLength(1);
    expect(pulls).toEqual(["qwen2.5-coder:1.5b-base"]);
  });

  it("chatView_creates_session_lazily_switches_and_reports_busy", async () => {
    let sessions: typeof SESSIONS = [];
    let created = 0;
    const client: FakeChatClient = new FakeChatClient((method: string, params: unknown): unknown => {
      if (method === "chat/listSessions") return { sessions };
      if (method === "chat/newSession") return { sessionId: `n${++created}` };
      if (method === "chat/send" && (params as { message: string }).message === "again") {
        throw Object.assign(new Error("a turn is already running"), { code: -32602 });
      }
      return defaultResponder(method, params);
    });
    const provider = makeProvider(client);
    providers.push(provider);
    const ui = fakeWebviewView();
    provider.resolveWebviewView(ui.view);

    ui.send({ type: "ui/ready" });
    await waitFor(() => ui.posted.some((m) => m.type === "session/list"), 5000, "list");
    expect(ui.posted[0]).toEqual({ type: "session/list", sessions: [], current: null });
    expect(client.of("chat/history")).toEqual([]); // no current session, no history request

    // First send with no session: create one, announce it, then send to it.
    ui.posted.length = 0;
    sessions = [{ sessionId: "n1", title: "New chat", updatedAtMs: 3 }];
    ui.send({ type: "chat/send", message: "hello", attachments: [] });
    await waitFor(() => client.of("chat/send").length === 1, 5000, "send");
    expect(client.of("chat/send")).toEqual([{ sessionId: "n1", message: "hello", attachments: [] }]);
    expect(ui.posted).toContainEqual({ type: "session/list", sessions, current: "n1" });
    expect(types(ui.posted)).not.toContain("session/history"); // would wipe the user's message

    // A second send while the turn runs → -32602 → ui/error, and no synthesized chat/done.
    ui.posted.length = 0;
    ui.send({ type: "chat/send", message: "again", attachments: [] });
    await waitFor(() => ui.posted.some((m) => m.type === "ui/error"), 5000, "busy error");
    expect(types(ui.posted)).not.toContain("chat/done");

    // New session → list + empty history; switch → list + that session's history.
    ui.posted.length = 0;
    ui.send({ type: "chat/newSession" });
    await waitFor(() => ui.posted.some((m) => m.type === "session/history"), 5000, "new session");
    expect(ui.posted.find((m) => m.type === "session/list")?.current).toBe("n2");
    expect(ui.posted.find((m) => m.type === "session/history")).toEqual({ type: "session/history", sessionId: "n2", messages: [] });
    expect(provider.currentSessionId).toBe("n2");

    ui.posted.length = 0;
    ui.send({ type: "chat/switchSession", sessionId: "n1" });
    await waitFor(() => ui.posted.some((m) => m.type === "session/history"), 5000, "switch");
    expect(ui.posted.find((m) => m.type === "session/list")?.current).toBe("n1");
    expect(ui.posted.find((m) => m.type === "session/history")).toEqual({ type: "session/history", sessionId: "n1", messages: HISTORY });
  });

  it("chatView_first_send_failing_to_create_session_still_ends_turn", async () => {
    let crash = false;
    const client = new FakeChatClient((method, params) => {
      if (method === "chat/listSessions") return { sessions: [] };
      if (method === "chat/newSession") {
        throw crash ? Object.assign(new Error("core exited"), { name: "CoreCrashed" }) : new Error("LocalPilot core is not running");
      }
      return defaultResponder(method, params);
    });
    const provider = makeProvider(client);
    providers.push(provider);
    const ui = fakeWebviewView();
    provider.resolveWebviewView(ui.view);

    for (const c of [false, true]) {
      crash = c;
      ui.posted.length = 0;
      ui.send({ type: "chat/send", message: "hello", attachments: [] });
      await waitFor(() => ui.posted.some((m) => m.type === "chat/done"), 5000, "done after failed session create");
      expect(ui.posted).toEqual([
        { type: "chat/done", sessionId: "", stopReason: "error" },
        { type: "ui/error", message: expect.stringMatching(/session/i) },
      ]);
      expect(client.of("chat/send")).toEqual([]);
    }

    // Stop with no session still unsticks the composer.
    ui.posted.length = 0;
    ui.send({ type: "chat/stop" });
    await waitFor(() => ui.posted.length > 0, 5000, "stop");
    expect(ui.posted).toEqual([{ type: "chat/done", sessionId: "", stopReason: "stopped" }]);
    expect(client.of("chat/stop")).toEqual([]);
  });

  it("chatView_forwards_editedArgs_on_approve", async () => {
    const client = new FakeChatClient(defaultResponder);
    const provider = makeProvider(client);
    providers.push(provider);
    const ui = fakeWebviewView();
    provider.resolveWebviewView(ui.view);
    ui.send({ type: "ui/ready" });
    await waitFor(() => provider.currentSessionId === "s2", 5000, "ready");

    client.emit("chat/toolCall", {
      sessionId: "s2",
      toolCallId: "t9",
      name: "run_command",
      args: { command: "npm test", cwd: "pkg" },
      requiresApproval: true,
      preview: "npm test",
    });
    // The UI's editedArgs is already the whole args object: passed through untouched.
    const editedArgs = { command: "npm test -- --run", cwd: "pkg" };
    ui.send({ type: "chat/approve", toolCallId: "t9", decision: "always", editedArgs });
    ui.send({ type: "chat/approve", toolCallId: "t10", decision: "deny" });
    await waitFor(() => client.of("chat/approve").length === 2, 5000, "approve");
    expect(client.of("chat/approve")).toEqual([
      { sessionId: "s2", toolCallId: "t9", decision: "always", editedArgs },
      { sessionId: "s2", toolCallId: "t10", decision: "deny" },
    ]);
    expect(client.of("chat/approve")[1]).not.toHaveProperty("editedArgs");
  });

  it("core_crash_mid_turn_emits_error_done_to_webview", async () => {
    // Real CoreClient + fake core. Requests: initialize #1, chat/listSessions #2,
    // chat/history #3, chat/send #4, chat/approve #5 → the core dies mid-turn.
    const client = new CoreClient({
      binaryPath: { command: process.execPath, args: [join(here, "fakeCore.mjs")], env: { FAKE_CRASH_AFTER: "5" } },
      workspaceRoot: here,
      logLevel: "info",
      onLog: () => {},
    });
    clients.push(client);
    await client.start(DEFAULT_SETTINGS);
    const provider = makeProvider(client);
    providers.push(provider);
    const ui = fakeWebviewView();
    provider.resolveWebviewView(ui.view);

    ui.send({ type: "ui/ready" });
    await waitFor(() => provider.currentSessionId === "fake-session", 5000, "ready");
    ui.send({ type: "chat/send", message: "edit it", attachments: [] });
    await waitFor(() => ui.posted.some((m) => m.type === "chat/toolCall"), 5000, "tool call");
    const call = ui.posted.find((m) => m.type === "chat/toolCall")!;
    // (The turn state came with the history on ui/ready.)
    expect(types(ui.posted.filter((m) => String(m.type).startsWith("chat/")))).toEqual(["chat/turnState", "chat/token", "chat/token", "chat/toolCall"]);

    ui.send({ type: "chat/approve", toolCallId: call.toolCallId, decision: "once" });
    await waitFor(() => ui.posted.some((m) => m.type === "chat/done"), 5000, "synthesized done");
    await waitFor(() => client.state === "ready", 5000, "restart");
    await new Promise((r) => setTimeout(r, 50)); // let any late rejection handlers run

    // Exactly one error turn end for the session, plus a visible error.
    expect(ui.posted.filter((m) => m.type === "chat/done")).toEqual([{ type: "chat/done", sessionId: "fake-session", stopReason: "error" }]);
    const errors = ui.posted.filter((m) => m.type === "ui/error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/core/i);

    // The restarted core keeps serving completions.
    const completion = await client.request<{ items: Array<{ text: string }> }>("completion/request", {
      uri: "file:///x.py",
      position: { line: 0, character: 0 },
      requestId: "1",
    });
    expect(completion.items[0].text).toBe("fake()");
  });

  it("chatView_reposts_pending_approvals_after_history", async () => {
    const client = new FakeChatClient(defaultResponder);
    const provider = makeProvider(client);
    providers.push(provider);
    const ui = fakeWebviewView();
    provider.resolveWebviewView(ui.view);
    ui.send({ type: "ui/ready" });
    await waitFor(() => provider.currentSessionId === "s2", 5000, "ready");

    ui.send({ type: "chat/send", message: "edit and run", attachments: [] });
    await waitFor(() => client.of("chat/send").length === 1, 5000, "send");
    const edit = { sessionId: "s2", toolCallId: "t1", name: "edit_file", args: { path: "a.py" }, requiresApproval: true, preview: "--- a" };
    const run = { sessionId: "s2", toolCallId: "t2", name: "run_command", args: { command: "ls" }, requiresApproval: true, preview: "ls" };
    client.emit("chat/toolCall", { sessionId: "s2", toolCallId: "t0", name: "read_file", args: { path: "a.py" }, requiresApproval: false });
    client.emit("chat/toolCall", edit);
    client.emit("chat/toolCall", run);

    // Away and back: the history replay is followed by the calls still awaiting a decision and the turn state.
    const switchTo = async (sessionId: string) => {
      ui.posted.length = 0;
      ui.send({ type: "chat/switchSession", sessionId });
      await waitFor(() => ui.posted.some((m) => m.type === "chat/turnState"), 5000, `switch to ${sessionId}`);
      return ui.posted.slice();
    };
    expect(await switchTo("s1")).toEqual([
      { type: "session/list", sessions: SESSIONS, current: "s1" },
      { type: "session/history", sessionId: "s1", messages: HISTORY },
      { type: "chat/turnState", sessionId: "s1", running: false },
    ]);
    expect(await switchTo("s2")).toEqual([
      { type: "session/list", sessions: SESSIONS, current: "s2" },
      { type: "session/history", sessionId: "s2", messages: HISTORY },
      { type: "chat/toolCall", ...edit },
      { type: "chat/toolCall", ...run },
      { type: "chat/turnState", sessionId: "s2", running: true },
    ]);

    // Decided (approve forwarded) or finished (toolResult) calls are no longer re-posted.
    ui.send({ type: "chat/approve", toolCallId: "t1", decision: "once" });
    await waitFor(() => client.of("chat/approve").length === 1, 5000, "approve");
    expect(client.of("chat/approve")).toEqual([{ sessionId: "s2", toolCallId: "t1", decision: "once" }]);
    let posted = await switchTo("s2");
    expect(posted.filter((m) => m.type === "chat/toolCall")).toEqual([{ type: "chat/toolCall", ...run }]);
    client.emit("chat/toolResult", { sessionId: "s2", toolCallId: "t2", ok: false, summary: "denied" });
    posted = await switchTo("s2");
    expect(posted.filter((m) => m.type === "chat/toolCall")).toEqual([]);
    expect(posted[posted.length - 1]).toEqual({ type: "chat/turnState", sessionId: "s2", running: true });

    // The turn ends: nothing pending, not running.
    client.emit("chat/toolCall", { ...run, toolCallId: "t3" });
    client.emit("chat/done", { sessionId: "s2", stopReason: "done" });
    posted = await switchTo("s2");
    expect(posted.filter((m) => m.type === "chat/toolCall")).toEqual([]);
    expect(posted[posted.length - 1]).toEqual({ type: "chat/turnState", sessionId: "s2", running: false });
  });

  it("chatView_stop_targets_the_running_session", async () => {
    const client = new FakeChatClient(defaultResponder);
    const provider = makeProvider(client);
    providers.push(provider);
    const ui = fakeWebviewView();
    provider.resolveWebviewView(ui.view);
    ui.send({ type: "ui/ready" });
    await waitFor(() => provider.currentSessionId === "s2", 5000, "ready");

    ui.send({ type: "chat/send", message: "long job", attachments: [] });
    await waitFor(() => client.of("chat/send").length === 1, 5000, "send");
    expect(chatActivity).toEqual([true]);
    ui.send({ type: "chat/switchSession", sessionId: "s1" });
    await waitFor(() => provider.currentSessionId === "s1", 5000, "switch");

    // s1 has no turn; the running one is s2's.
    ui.send({ type: "chat/stop" });
    await waitFor(() => client.of("chat/stop").length === 1, 5000, "stop");
    expect(client.of("chat/stop")).toEqual([{ sessionId: "s2" }]);

    // With both running, Stop stops the session on screen.
    ui.send({ type: "chat/send", message: "another", attachments: [] });
    await waitFor(() => client.of("chat/send").length === 2, 5000, "send 2");
    ui.send({ type: "chat/stop" });
    await waitFor(() => client.of("chat/stop").length === 2, 5000, "stop 2");
    expect(client.of("chat/stop")[1]).toEqual({ sessionId: "s1" });

    // Completions resume (status bar) only when the last turn ends.
    client.emit("chat/done", { sessionId: "s1", stopReason: "stopped" });
    expect(chatActivity).toEqual([true]);
    client.emit("chat/done", { sessionId: "s2", stopReason: "stopped" });
    expect(chatActivity).toEqual([true, false]);
  });

  it("chatView_forwards_only_attachments_lp_syncs", async () => {
    const client = new FakeChatClient(defaultResponder);
    const provider = makeProvider(client);
    providers.push(provider);
    const ui = fakeWebviewView();
    provider.resolveWebviewView(ui.view);
    ui.send({ type: "ui/ready" });
    await waitFor(() => provider.currentSessionId === "s2", 5000, "ready");

    const sel = { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } };
    ui.send({
      type: "chat/send",
      message: "look",
      attachments: [
        { uri: "file:///work/proj/a.py", range: sel },
        { uri: "file:///work/proj/nb.ipynb.cell0.py" },
        { uri: "file:///etc/passwd" }, // outside the workspace
        { uri: "file:///work/proj-2/b.py" }, // a sibling, not inside
        { uri: "untitled:Untitled-1" },
        { uri: "::bad" },
        { uri: 42 },
        "file:///work/proj/c.py",
        { uri: "file:///work/proj/d.py", range: { start: "x" } }, // malformed range: dropped, file kept
      ],
    });
    await waitFor(() => client.of("chat/send").length === 1, 5000, "send");
    expect(client.of("chat/send")).toEqual([
      {
        sessionId: "s2",
        message: "look",
        attachments: [{ uri: "file:///work/proj/a.py", range: sel }, { uri: "file:///work/proj/nb.ipynb.cell0.py" }, { uri: "file:///work/proj/d.py" }],
      },
    ]);
  });
});
