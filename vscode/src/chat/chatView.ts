import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { syncUri } from "../documentSync";
import { isModelKind, MODEL_SETTING, ModelCatalog, type ModelKind } from "../models";
import type { CoreClient } from "../rpc/coreClient";
import { readSettings, updateSetting, type Settings } from "../settings";

export const CHAT_VIEW_TYPE = "localpilot.chat";

/** Core notifications relayed to the webview as `{ type: <method>, ...params }`. */
const RELAYED = ["chat/token", "chat/toolCall", "chat/toolResult", "chat/done", "status"] as const;

export interface StatusNotification {
  ollama: "ok" | "down" | "modelMissing";
  detail: string;
}

interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAtMs: number;
}

export type ChatClient = Pick<CoreClient, "request" | "onNotification" | "onDidChangeState">;

export interface ChatViewDeps {
  extensionUri: vscode.Uri;
  /** Workspace root: decides which editors can be attached (same rule as document sync). */
  root: string;
  /** The chat-ui single-file bundle (`media/chat.html`); read when the view is first shown. */
  html: () => string;
  startOllama: () => void;
  /** Called when the first chat turn starts (true) and when the last one ends (false). */
  onChatActiveChanged?: (active: boolean) => void;
  /** Shared `ollama/models` cache (the palette pickers use the same one); one of our own by default. */
  models?: ModelCatalog;
}

/** The settings the chat UI's settings panel edits with `settings/set` (the completion model goes through `model/select`). */
/** Panel number settings and their minimums (as in package.json). */
const PANEL_NUMBERS = { completionMaxTokens: 1, completionDebounceMs: 0, completionContextTokens: 256 } as const;
const PANEL_BOOLEANS = ["adaptiveCompletions"] as const;

/** What `chat/deleteSession` / `chat/clearSessions` did, for the palette commands. */
export interface ClearResult {
  deleted: string[];
  skipped: string[];
}

type Msg = Record<string, unknown> & { type: string };

const INVALID_PARAMS = -32602;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isCrash = (e: unknown) => e instanceof Error && e.name === "CoreCrashed";

/** The webview's Content-Security-Policy: nothing external, only our nonce'd script. */
export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return `default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:`;
}

/** Adds the CSP `<meta>` at the top of `<head>` and the nonce to every `<script>` tag. */
export function renderHtml(template: string, cspSource: string, nonce: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(cspSource, nonce)}">`;
  const withNonce = template.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
  const head = /<head[^>]*>/i.exec(withNonce);
  if (!head) return `${meta}\n${withNonce}`;
  const at = head.index + head[0].length;
  return `${withNonce.slice(0, at)}\n    ${meta}${withNonce.slice(at)}`;
}

/**
 * Hosts the shared chat-ui bundle in the sidebar and bridges it to the core:
 * UI messages become core requests (with the current session filled in) and
 * core chat notifications are forwarded to the UI. If the core goes away
 * while a turn is running, the UI gets `chat/done { stopReason: "error" }`
 * and a `ui/error`, so it never waits on a turn that cannot finish.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = CHAT_VIEW_TYPE;

  private view?: vscode.WebviewView;
  private current: string | null = null;
  private sessions: SessionSummary[] = [];
  private status?: StatusNotification;
  /** Sessions with a turn the UI is waiting on (`chat/send` until `chat/done`). */
  private readonly activeTurns = new Set<string>();
  /** Which session a tool call belongs to, for `chat/approve`. */
  private readonly toolCallSessions = new Map<string, string>();
  /**
   * Per session, the `chat/toolCall` params of calls the core is still waiting
   * to have decided; re-sent after that session's `session/history`, which does
   * not show them as awaiting approval.
   */
  private readonly pendingCalls = new Map<string, Map<string, Record<string, unknown>>>();
  private lastActiveFile = "";
  private readonly models: ModelCatalog;
  /** Per-topic chains: messages of one topic are handled in order (e.g. resetLearning before the stats that follow it). */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private viewSubscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly client: ChatClient,
    private readonly deps: ChatViewDeps,
  ) {
    this.models = deps.models ?? new ModelCatalog(client);
    for (const method of RELAYED) {
      this.subscriptions.push(client.onNotification(method, (params) => this.onCoreNotification(method, params)));
    }
    this.subscriptions.push(
      client.onDidChangeState((state) => {
        if (state !== "ready") this.failActiveTurns("The LocalPilot core stopped during the reply" + (state === "starting" ? "; it is restarting." : "."));
      }),
    );
  }

  get currentSessionId(): string | null {
    return this.current;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    for (const d of this.viewSubscriptions) d.dispose();
    this.view = view;
    this.lastActiveFile = "";
    view.webview.options = { enableScripts: true, localResourceRoots: [this.deps.extensionUri] };
    const nonce = randomBytes(18).toString("base64");
    let template: string;
    try {
      template = this.deps.html();
    } catch (e) {
      template = `<!doctype html><html><head></head><body><p>LocalPilot chat UI is missing (${escapeHtml(errorMessage(e))}). Rebuild the extension.</p></body></html>`;
    }
    view.webview.html = renderHtml(template, view.webview.cspSource, nonce);
    this.viewSubscriptions = [
      view.webview.onDidReceiveMessage((msg: unknown) => void this.onUiMessage(msg)),
      vscode.window.onDidChangeActiveTextEditor(() => this.postActiveFile()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.postActiveFile();
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
      }),
    ];
  }

  /** Latest Ollama status (from `initialize` or a `status` notification); forwarded to the UI. */
  setStatus(status: StatusNotification): void {
    this.status = status;
    this.post({ type: "status", ...status });
  }

  /** Starts a new chat session and shows it (command `localpilot.newSession`). */
  async newSession(): Promise<void> {
    try {
      const { sessionId } = await this.client.request<{ sessionId: string }>("chat/newSession", {});
      this.current = sessionId;
      await this.postSessionList();
      this.post({ type: "session/history", sessionId, messages: [] });
    } catch (e) {
      this.postError(`Could not start a new session: ${errorMessage(e)}`);
    }
  }

  /**
   * Core `chat/deleteSession`. On success the UI gets `session/deleted { sessionId, next }`
   * (next = the most recent remaining session) and then the refreshed `session/list`;
   * if the core refuses (the session's turn is running) it gets a `ui/error` saying so.
   * Returns that error message, or undefined on success.
   */
  async deleteSession(sessionId: string): Promise<string | undefined> {
    try {
      await this.client.request("chat/deleteSession", { sessionId });
    } catch (e) {
      // The core answers -32602 both for a running turn ("turn running …") and for an invalid id.
      const running = (e as { code?: unknown }).code === INVALID_PARAMS && /turn running/i.test(errorMessage(e));
      const message = running
        ? "That chat session's reply is still running. Wait for it or press Stop, then delete it."
        : `Could not delete the chat session: ${errorMessage(e)}`;
      if (!isCrash(e)) this.postError(message);
      return message;
    }
    this.forgetSession(sessionId);
    const remaining = await this.fetchSessions().catch(() => this.sessions.filter((s) => s.sessionId !== sessionId));
    const next = remaining.find((s) => s.sessionId !== sessionId)?.sessionId ?? null;
    if (this.current === sessionId) this.current = next;
    this.post({ type: "session/deleted", sessionId, next });
    this.sessions = remaining;
    this.post({ type: "session/list", sessions: remaining, current: this.current });
    return undefined;
  }

  /**
   * Core `chat/clearSessions`: one `session/deleted` per deleted session (next = the most
   * recent survivor, i.e. a session whose turn is running, or null), a notice for the kept
   * ones, then the refreshed `session/list`.
   */
  async clearSessions(): Promise<ClearResult> {
    const before = await this.fetchSessions().catch(() => this.sessions);
    let skipped: string[];
    try {
      ({ skipped } = await this.client.request<{ deleted: number; skipped: string[] }>("chat/clearSessions", {}));
    } catch (e) {
      if (!isCrash(e)) this.postError(`Could not clear the chat sessions: ${errorMessage(e)}`);
      throw e;
    }
    skipped = Array.isArray(skipped) ? skipped : [];
    const after = await this.fetchSessions().catch(() => before.filter((s) => skipped.includes(s.sessionId)));
    const survivors = new Set(after.map((s) => s.sessionId));
    const deleted = before.map((s) => s.sessionId).filter((id) => !survivors.has(id));
    const next = after[0]?.sessionId ?? null;
    for (const id of deleted) {
      this.forgetSession(id);
      if (this.current === id) this.current = next;
      this.post({ type: "session/deleted", sessionId: id, next });
    }
    if (skipped.length > 0) {
      const n = skipped.length;
      this.postError(`${n} session${n === 1 ? "" : "s"} with a running reply ${n === 1 ? "was" : "were"} kept.`);
    }
    this.sessions = after;
    this.post({ type: "session/list", sessions: after, current: this.current });
    return { deleted, skipped };
  }

  dispose(): void {
    for (const d of [...this.subscriptions, ...this.viewSubscriptions]) d.dispose();
    this.subscriptions.length = 0;
    this.viewSubscriptions = [];
    this.view = undefined;
  }

  // ------------------------------------------------------------ core → UI

  private onCoreNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "status") this.status = p as unknown as StatusNotification;
    if (method === "chat/toolCall" && typeof p.toolCallId === "string" && typeof p.sessionId === "string") {
      this.toolCallSessions.set(p.toolCallId, p.sessionId);
      if (p.requiresApproval === true) {
        let pending = this.pendingCalls.get(p.sessionId);
        if (!pending) this.pendingCalls.set(p.sessionId, (pending = new Map()));
        pending.set(p.toolCallId, { ...p });
      }
    }
    if (method === "chat/toolResult" && typeof p.toolCallId === "string" && typeof p.sessionId === "string") {
      this.pendingCalls.get(p.sessionId)?.delete(p.toolCallId);
    }
    if (method === "chat/done" && typeof p.sessionId === "string") {
      this.endTurn(p.sessionId);
      this.pendingCalls.delete(p.sessionId);
      for (const [id, sid] of this.toolCallSessions) if (sid === p.sessionId) this.toolCallSessions.delete(id);
    }
    this.post({ ...p, type: method });
    // A finished turn may have titled the session: refresh the switcher.
    if (method === "chat/done") void this.postSessionList().catch(() => {});
  }

  /** Ends every turn the UI is waiting on with an error (the core died or was restarted). */
  private failActiveTurns(message: string): void {
    if (this.activeTurns.size === 0) return;
    const sessions = [...this.activeTurns];
    this.activeTurns.clear();
    this.toolCallSessions.clear();
    this.pendingCalls.clear();
    this.deps.onChatActiveChanged?.(false);
    for (const sessionId of sessions) this.post({ type: "chat/done", sessionId, stopReason: "error" });
    this.postError(message);
  }

  // ------------------------------------------------------------ UI → core

  private async onUiMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null || typeof (raw as Msg).type !== "string") return;
    const msg = raw as Msg;
    try {
      switch (msg.type) {
        case "ui/ready":
          return await this.onReady();
        case "chat/send":
          return await this.send(String(msg.message ?? ""), this.validAttachments(msg.attachments));
        case "chat/stop": {
          // The turn on screen, else the one that is running elsewhere (Stop shows only while one runs).
          const target = this.current && this.activeTurns.has(this.current) ? this.current : ([...this.activeTurns].pop() ?? this.current);
          if (target) await this.client.request("chat/stop", { sessionId: target });
          // Nothing to stop in the core: still end the UI's turn so Stop always unsticks the composer.
          else this.post({ type: "chat/done", sessionId: "", stopReason: "stopped" });
          return;
        }
        case "chat/approve":
          return await this.approve(msg);
        case "chat/newSession":
          return await this.newSession();
        case "chat/switchSession":
          if (typeof msg.sessionId === "string") await this.switchSession(msg.sessionId);
          return;
        case "ui/insertAtCursor":
          return await this.insertAtCursor(String(msg.text ?? ""));
        case "ui/copy":
          await vscode.env.clipboard.writeText(String(msg.text ?? ""));
          return;
        case "ollama/start":
          this.deps.startOllama();
          return;
        case "models/list":
          return await this.postModels();
        case "model/select":
          return await this.inOrder("settings", () => this.selectModel(msg.kind, msg.name));
        case "settings/get":
          return this.postSettings();
        case "settings/set":
          return await this.inOrder("settings", () => this.applySettings(msg.patch));
        case "session/delete":
          if (typeof msg.sessionId === "string") {
            const id = msg.sessionId;
            await this.inOrder("sessions", () => this.deleteSession(id));
          }
          return;
        case "session/clearAll":
          // clearSessions already told the UI about a failure.
          await this.inOrder("sessions", () => this.clearSessions().catch(() => undefined));
          return;
        case "completion/stats":
          return await this.inOrder("completion", () => this.postStats());
        case "completion/resetLearning":
          return await this.inOrder("completion", () => this.client.request("completion/resetLearning", {}));
        default:
          return; // ui/openDiff and unknown messages: nothing to do
      }
    } catch (e) {
      // A crash is reported once, by the state handler.
      if (!isCrash(e)) this.postError(errorMessage(e));
    }
  }

  private async onReady(): Promise<void> {
    // Order matters: the UI keys tool cards by session, so the list goes first.
    try {
      await this.postSessionList();
      if (this.current) await this.postHistory(this.current);
      // Turns running in other sessions too, so the UI keeps their delete buttons disabled.
      for (const sessionId of this.activeTurns) {
        if (sessionId !== this.current) this.post({ type: "chat/turnState", sessionId, running: true });
      }
    } catch (e) {
      this.post({ type: "session/list", sessions: [], current: this.current });
      if (!isCrash(e)) this.postError(`LocalPilot core is not available: ${errorMessage(e)}`);
    }
    if (this.status) this.post({ type: "status", ...this.status });
    this.postActiveFile(true);
  }

  private async send(message: string, attachments: unknown[]): Promise<void> {
    let sessionId = this.current;
    if (!sessionId) {
      try {
        sessionId = (await this.client.request<{ sessionId: string }>("chat/newSession", {})).sessionId;
      } catch (e) {
        // The UI is already showing a pending reply; end it (no session yet, so the UI accepts "").
        this.post({ type: "chat/done", sessionId: this.current ?? "", stopReason: "error" });
        this.postError(`Could not start a chat session: ${errorMessage(e)}`);
        return;
      }
      this.current = sessionId;
      // Announce the session before any of its turn events arrive.
      await this.postSessionList().catch(() => this.post({ type: "session/list", sessions: this.sessions, current: sessionId }));
    }
    this.startTurn(sessionId);
    try {
      await this.client.request("chat/send", { sessionId, message, attachments });
    } catch (e) {
      if ((e as { code?: unknown }).code === INVALID_PARAMS) {
        // That session's previous turn is still running; it will end with its own chat/done.
        this.postError("A reply is still in progress in this session. Wait for it or press Stop.");
        return;
      }
      if (isCrash(e)) return; // reported by the state handler
      if (this.endTurn(sessionId)) this.post({ type: "chat/done", sessionId, stopReason: "error" });
      this.postError(`Could not send the message: ${errorMessage(e)}`);
    }
  }

  private async approve(msg: Msg): Promise<void> {
    const toolCallId = String(msg.toolCallId ?? "");
    const sessionId = this.toolCallSessions.get(toolCallId) ?? this.current;
    if (!sessionId) return;
    const params: Record<string, unknown> = { sessionId, toolCallId, decision: msg.decision };
    // editedArgs is already the complete args object (the core replaces args wholesale).
    if (msg.editedArgs !== undefined) params.editedArgs = msg.editedArgs;
    await this.client.request("chat/approve", params);
    // Decided (and the core took it): never offer it again after a history replay.
    this.pendingCalls.get(sessionId)?.delete(toolCallId);
  }

  private async switchSession(sessionId: string): Promise<void> {
    this.current = sessionId;
    this.post({ type: "session/list", sessions: this.sessions, current: sessionId });
    await this.postHistory(sessionId);
  }

  // ------------------------------------------------------------ models, settings, stats

  /** Runs `fn` after every earlier call with the same `topic` has settled. */
  private inOrder<T>(topic: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(topic) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => {},
      () => {},
    );
    this.chains.set(topic, settled);
    void settled.then(() => {
      if (this.chains.get(topic) === settled) this.chains.delete(topic);
    });
    return run;
  }

  /**
   * `models/list`: core `ollama/models` + the configured choices; `ollama: "down"` with `error` when that fails.
   * Also called after a palette model pick, so an open chat view shows the new choice.
   */
  async postModels(): Promise<void> {
    if (!this.view) return;
    let msg: Msg;
    try {
      const models = await this.models.fetch();
      // Ollama answered, so a stale "down" status no longer applies; "modelMissing" still does.
      const ollama = this.status?.ollama === "modelMissing" ? "modelMissing" : "ok";
      msg = { type: "models/list", models, current: this.currentModels(), ollama };
    } catch (e) {
      msg = { type: "models/list", models: [], current: this.currentModels(), ollama: "down", error: errorMessage(e) };
    }
    this.post(msg);
  }

  private currentModels(): { chat: string; completion: string } {
    const s = readSettings();
    return { chat: s.chatModel, completion: s.completionModel };
  }

  /**
   * `model/select`: writes the chat/completion model setting (the core restarts), then always answers `models/list`.
   * Only a name from the last-known installed list (fetched first if there is none yet) or the current setting is
   * written — the webview is not trusted to name arbitrary models.
   */
  private async selectModel(kind: unknown, name: unknown): Promise<void> {
    if (isModelKind(kind) && typeof name === "string" && name.trim()) {
      const model = name.trim();
      if (await this.isSelectable(kind, model)) {
        try {
          await updateSetting(MODEL_SETTING[kind], model);
        } catch (e) {
          this.postError(`Could not save the ${kind} model: ${errorMessage(e)}`);
        }
      } else {
        this.postError(`Model "${model}" is not installed in Ollama.`);
      }
    }
    await this.postModels();
  }

  private async isSelectable(kind: ModelKind, model: string): Promise<boolean> {
    if (this.currentModels()[kind] === model) return true;
    const known = this.models.lastKnown ?? (await this.models.fetch().catch(() => undefined));
    return known?.some((m) => m.name === model) ?? false;
  }

  private postSettings(): void {
    const s = readSettings();
    this.post({
      type: "settings/current",
      settings: {
        completionModel: s.completionModel,
        completionMaxTokens: s.completionMaxTokens,
        completionDebounceMs: s.completionDebounceMs,
        completionContextTokens: s.completionContextTokens,
        adaptiveCompletions: s.adaptiveCompletions,
      },
    });
  }

  /** `settings/set { patch }`: writes the panel's keys (others are ignored), then always answers `settings/current`. */
  private async applySettings(patch: unknown): Promise<void> {
    const p = (typeof patch === "object" && patch !== null ? patch : {}) as Record<string, unknown>;
    const writes: Array<[keyof Settings, unknown]> = [];
    for (const [key, min] of Object.entries(PANEL_NUMBERS) as Array<[keyof typeof PANEL_NUMBERS, number]>) {
      const v = p[key];
      if (typeof v === "number" && Number.isFinite(v)) writes.push([key, Math.max(min, Math.round(v))]);
    }
    for (const key of PANEL_BOOLEANS) if (typeof p[key] === "boolean") writes.push([key, p[key]]);
    for (const [key, value] of writes) {
      try {
        await updateSetting(key, value);
      } catch (e) {
        this.postError(`Could not save ${key}: ${errorMessage(e)}`);
      }
    }
    this.postSettings();
  }

  private async postStats(): Promise<void> {
    const stats = await this.client.request("completion/stats", {});
    this.post({ type: "completion/stats", stats });
  }

  // ------------------------------------------------------------ helpers

  private async fetchSessions(): Promise<SessionSummary[]> {
    const { sessions } = await this.client.request<{ sessions: SessionSummary[] }>("chat/listSessions", {});
    return sessions;
  }

  /** Drops the host's per-session bookkeeping for a deleted session. */
  private forgetSession(sessionId: string): void {
    this.pendingCalls.delete(sessionId);
    for (const [id, sid] of this.toolCallSessions) if (sid === sessionId) this.toolCallSessions.delete(id);
    if (this.endTurn(sessionId)) this.post({ type: "chat/done", sessionId, stopReason: "stopped" });
  }

  private async postSessionList(): Promise<void> {
    const { sessions } = await this.client.request<{ sessions: SessionSummary[] }>("chat/listSessions", {});
    this.sessions = sessions;
    if (this.current === null && sessions.length > 0) this.current = sessions[0].sessionId;
    this.post({ type: "session/list", sessions, current: this.current });
  }

  private async postHistory(sessionId: string): Promise<void> {
    const result = await this.client.request<{ sessionId: string; messages: unknown[] }>("chat/history", { sessionId });
    if (this.current !== sessionId) return; // switched again meanwhile
    this.post({ type: "session/history", sessionId, messages: result.messages });
    // History shows tool calls as settled: re-offer those still awaiting a decision,
    // and tell the UI whether this session's turn is still running (Stop).
    for (const call of this.pendingCalls.get(sessionId)?.values() ?? []) this.post({ ...call, type: "chat/toolCall" });
    this.post({ type: "chat/turnState", sessionId, running: this.activeTurns.has(sessionId) });
  }

  private startTurn(sessionId: string): void {
    const wasIdle = this.activeTurns.size === 0;
    this.activeTurns.add(sessionId);
    if (wasIdle) this.deps.onChatActiveChanged?.(true);
  }

  /** Forgets `sessionId`'s turn; true if it was running. */
  private endTurn(sessionId: string): boolean {
    if (!this.activeTurns.delete(sessionId)) return false;
    if (this.activeTurns.size === 0) this.deps.onChatActiveChanged?.(false);
    return true;
  }

  /**
   * Attachments from the webview, kept only if they name a document the core
   * syncs (a `file:` path inside the workspace, or a notebook cell's virtual
   * path); a malformed range is dropped, the attachment kept.
   */
  private validAttachments(raw: unknown): Array<{ uri: string; range?: unknown }> {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ uri: string; range?: unknown }> = [];
    for (const a of raw) {
      if (typeof a !== "object" || a === null || typeof (a as { uri?: unknown }).uri !== "string") continue;
      const { uri, range } = a as { uri: string; range?: unknown };
      let parsed: vscode.Uri;
      try {
        parsed = vscode.Uri.parse(uri, true);
      } catch {
        continue;
      }
      if (!syncUri({ uri: parsed } as vscode.TextDocument, this.deps.root)) continue;
      out.push(isRange(range) ? { uri, range } : { uri });
    }
    return out;
  }

  private postActiveFile(force = false): void {
    const editor = vscode.window.activeTextEditor;
    const uri = editor ? syncUri(editor.document, this.deps.root) : undefined;
    const msg: Msg = { type: "ui/activeFile", uri: uri ?? null };
    if (uri && editor) {
      const s = editor.selection;
      msg.selection = { start: { line: s.start.line, character: s.start.character }, end: { line: s.end.line, character: s.end.character } };
    }
    const key = JSON.stringify(msg);
    if (!force && key === this.lastActiveFile) return;
    this.lastActiveFile = key;
    this.post(msg);
  }

  private async insertAtCursor(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("LocalPilot: open an editor to insert the code into.");
      return;
    }
    await editor.edit((b) => {
      for (const sel of editor.selections) b.replace(sel, text);
    });
  }

  private postError(message: string): void {
    this.post({ type: "ui/error", message });
  }

  private post(msg: Msg): void {
    void this.view?.webview.postMessage(msg);
  }
}

const isPosition = (p: unknown): boolean =>
  typeof p === "object" && p !== null && Number.isInteger((p as { line?: unknown }).line) && Number.isInteger((p as { character?: unknown }).character);

function isRange(r: unknown): boolean {
  return typeof r === "object" && r !== null && isPosition((r as { start?: unknown }).start) && isPosition((r as { end?: unknown }).end);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
