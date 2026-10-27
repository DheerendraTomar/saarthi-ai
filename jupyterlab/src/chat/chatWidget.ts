import type { IDisposable } from '@lumino/disposable';
import { Widget } from '@lumino/widgets';
import type { OllamaStatus, WsCoreClient } from '../client';
import type { Settings } from '../settings';
import { isSafeCssValue } from './theme';

/** The sidebar widget's id (also what `localpilot:open-chat` activates). */
export const CHAT_WIDGET_ID = 'localpilot-chat';

/** Core notifications relayed to the UI as `{ type: <method>, ...params }`. */
const RELAYED = ['chat/token', 'chat/toolCall', 'chat/toolResult', 'chat/done', 'status'] as const;

/** Sent by the server bridge to every other tab after a tab deleted chat sessions. */
export const SESSIONS_CHANGED = 'localpilot/sessionsChanged';

/** One installed model, as core `ollama/models` reports it. */
export interface ModelInfo {
  name: string;
  sizeBytes: number;
  family?: string;
  supportsInsert: boolean;
  supportsTools: boolean;
}

export type ModelKind = 'chat' | 'completion';

/** The setting each model kind writes. */
export const MODEL_SETTING: Readonly<Record<ModelKind, 'chatModel' | 'completionModel'>> = Object.freeze({
  chat: 'chatModel',
  completion: 'completionModel'
});

export const isModelKind = (k: unknown): k is ModelKind => k === 'chat' || k === 'completion';

/** The settings panel's number settings and their minimums (as in schema/plugin.json). */
const PANEL_NUMBERS = { completionMaxTokens: 1, completionDebounceMs: 0, completionContextTokens: 256 } as const;
const PANEL_BOOLEANS = ['adaptiveCompletions'] as const;

/**
 * The iframe's sandbox: scripts only. No `allow-same-origin` (the frame gets an
 * opaque origin: no cookies, storage or same-origin requests to the Jupyter
 * server, no reach into this page), no top navigation, no forms. Popups are
 * allowed, escaping the sandbox, so a link in a reply opens in a new tab
 * (`<base target="_blank">`) instead of replacing the chat.
 */
export const IFRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

/**
 * The frame's Content-Security-Policy: the bundle is one file with inline
 * script and style and makes no requests; nothing else may load.
 */
export const CHAT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}

/** What the active notebook cell / file editor is, as the core knows it. */
export interface ActiveFile {
  uri: string;
  selection?: Range;
}

export type ChatClient = Pick<WsCoreClient, 'request' | 'onNotification' | 'onDisconnect' | 'onReconnect' | 'isDisposed'>;

export interface ChatWidgetDeps {
  /** The chat-ui single-file bundle. */
  html: () => string;
  /** The active cell / file editor (synced URI + selection), or undefined. */
  activeFile?: () => ActiveFile | undefined;
  /** Whether `uri` names a document the core has (a synced cell or file): attachments are filtered by it. */
  isSyncedUri?: (uri: string) => boolean;
  /** Inserts at the active cell's / editor's cursor; false when there is none. */
  insertAtCursor?: (text: string) => boolean;
  /** Clipboard write for the UI's Copy buttons (the sandboxed frame has no clipboard access). */
  copy?: (text: string) => Promise<void> | void;
  startOllama: () => void;
  /** `""` → the configured completion model. */
  /** Called when the first chat turn starts (true) and when the last one ends (false). */
  onChatActiveChanged?: (active: boolean) => void;
  /** The host theme as `--vscode-*` custom properties (`jupyterThemeVars`). */
  themeVars?: () => Record<string, string>;
  /** The current LocalPilot settings (models/list `current`, settings/current). */
  settings?: () => Settings;
  /** Persists one setting in the settings registry (a core setting restarts the core). */
  setSetting?: (key: keyof Settings, value: unknown) => Promise<void>;
}

interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAtMs: number;
}

type Msg = Record<string, unknown> & { type: string };

const INVALID_PARAMS = -32602;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** The socket closed under the request: reported once, by the disconnect handler. */
const isDisconnect = (e: unknown) => e instanceof Error && e.name === 'CoreDisconnected';

/** Only `--vscode-*` names with values that cannot break out of the `<style>` block. */
function safeThemeVars(vars: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars ?? {})) {
    if (/^--vscode-[A-Za-z0-9.-]+$/.test(name) && typeof value === 'string' && isSafeCssValue(value)) out[name] = value;
  }
  return out;
}

/**
 * Adds the CSP `<meta>`, `<base target="_blank">` and the host theme (as
 * `--vscode-*` custom properties on `:root`) at the top of `<head>`, before
 * the bundle's own styles.
 */
export function renderHtml(template: string, themeVars?: Record<string, string>): string {
  const vars = Object.entries(safeThemeVars(themeVars))
    .map(([name, value]) => `${name}:${value};`)
    .join('');
  const theme = vars ? `<style id="lp-host-theme">:root{${vars}}</style>` : '';
  const head = `<meta http-equiv="Content-Security-Policy" content="${CHAT_CSP}"><base target="_blank">${theme}`;
  const m = /<head[^>]*>/i.exec(template);
  if (!m) return `${head}\n${template}`;
  const at = m.index + m[0].length;
  return `${template.slice(0, at)}\n    ${head}${template.slice(at)}`;
}

/**
 * The LocalPilot chat sidebar: the shared chat-ui bundle in a sandboxed
 * `<iframe srcdoc>` (chat-ui's `IframeBridge` talks to this page with
 * `postMessage`), bridged to the core like VS Code's chat view: UI messages
 * become core requests (with the current session filled in) and core chat
 * notifications are forwarded to the UI. Messages are accepted only from this
 * iframe's window. If the core connection drops while a turn is running, the
 * UI gets `chat/done { stopReason: "error" }` and a `ui/error`, so it never
 * waits on a turn that cannot finish. After a reconnect the session list and
 * the current session's history are fetched again: the bridge sees this tab
 * as a new one, so that `chat/history` re-adopts a session whose turn kept
 * running in the core and replays its tool call still awaiting approval.
 */
export class ChatWidget extends Widget {
  readonly iframe: HTMLIFrameElement;

  private current: string | null = null;
  private sessions: SessionSummary[] = [];
  private status?: OllamaStatus;
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
  private lastActiveFile = '';
  /** The theme the UI has (srcdoc or the last `ui/theme`), to skip unchanged updates. */
  private lastTheme = '';
  /** The last successful `ollama/models` answer (what `model/select` may write). */
  private knownModels?: ModelInfo[];
  /** Per-topic chains: messages of one topic are handled in order (e.g. resetLearning before the stats that follow it). */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly subscriptions: IDisposable[] = [];

  constructor(
    private readonly client: ChatClient,
    private readonly deps: ChatWidgetDeps
  ) {
    super();
    this.id = CHAT_WIDGET_ID;
    this.addClass('jp-LocalPilotChat');
    this.title.caption = 'LocalPilot chat';

    const iframe = (this.iframe = document.createElement('iframe'));
    iframe.className = 'jp-LocalPilotChat-frame';
    iframe.title = 'LocalPilot chat';
    // The sandbox must be in place before the document is set.
    iframe.setAttribute('sandbox', IFRAME_SANDBOX);
    let template: string;
    try {
      template = deps.html();
    } catch (e) {
      template = `<!doctype html><html><head></head><body><p>LocalPilot chat UI is missing (${escapeHtml(errorMessage(e))}). Rebuild the extension.</p></body></html>`;
    }
    const theme = this.currentTheme();
    this.lastTheme = JSON.stringify(theme);
    iframe.setAttribute('srcdoc', renderHtml(template, theme));
    this.node.appendChild(iframe);
    window.addEventListener('message', this.onWindowMessage);

    for (const method of RELAYED) {
      this.subscriptions.push(client.onNotification(method, (params) => this.onCoreNotification(method, params)));
    }
    this.subscriptions.push(
      client.onNotification(SESSIONS_CHANGED, () => {
        if (!this.isDisposed) void this.inOrder('sessions', () => this.sessionsChangedElsewhere());
      }),
      client.onDisconnect(() => {
        // dispose()/reconnect() of a ready client also report a disconnect.
        if (!this.isDisposed) this.failActiveTurns('The LocalPilot core stopped during the reply.');
      }),
      client.onReconnect(() => {
        if (!this.isDisposed) void this.resync();
      })
    );
  }

  get currentSessionId(): string | null {
    return this.current;
  }

  /** Latest Ollama status (from `initialize` or a `status` notification); forwarded to the UI. */
  setStatus(status: OllamaStatus): void {
    this.status = status;
    this.post({ type: 'status', ...status });
  }

  /** The active cell / editor or its selection may have changed: tell the UI if it did. */
  activeFileChanged(): void {
    this.postActiveFile();
  }

  /**
   * The host theme may have changed: send the UI the new `--vscode-*` values
   * (`ui/theme`) if they differ. The srcdoc is left alone: resetting it would
   * reload the frame and lose the draft.
   */
  themeChanged(): void {
    this.postTheme();
  }

  /** Starts a new chat session and shows it (command `localpilot:new-session`). */
  async newSession(): Promise<void> {
    try {
      const { sessionId } = await this.client.request<{ sessionId: string }>('chat/newSession', {});
      this.current = sessionId;
      await this.postSessionList();
      this.post({ type: 'session/history', sessionId, messages: [] });
    } catch (e) {
      this.postError(`Could not start a new session: ${errorMessage(e)}`);
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    window.removeEventListener('message', this.onWindowMessage);
    for (const d of this.subscriptions) d.dispose();
    this.subscriptions.length = 0;
    super.dispose();
  }

  // ------------------------------------------------------------ core → UI

  private onCoreNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === 'status') this.status = p as unknown as OllamaStatus;
    /** A session this tab adopted while its turn waits on an approval (the bridge replays the call). */
    let adopted: string | undefined;
    if (method === 'chat/toolCall' && typeof p.toolCallId === 'string' && typeof p.sessionId === 'string') {
      this.toolCallSessions.set(p.toolCallId, p.sessionId);
      if (p.requiresApproval === true) {
        let pending = this.pendingCalls.get(p.sessionId);
        if (!pending) this.pendingCalls.set(p.sessionId, (pending = new Map()));
        pending.set(p.toolCallId, { ...p });
        // The turn is running here too (Stop, chat-active), until its chat/done.
        if (!this.activeTurns.has(p.sessionId)) {
          this.startTurn(p.sessionId);
          adopted = p.sessionId;
        }
      }
    }
    if (method === 'chat/toolResult' && typeof p.toolCallId === 'string' && typeof p.sessionId === 'string') {
      this.pendingCalls.get(p.sessionId)?.delete(p.toolCallId);
    }
    if (method === 'chat/done' && typeof p.sessionId === 'string') {
      this.endTurn(p.sessionId);
      this.pendingCalls.delete(p.sessionId);
      for (const [id, sid] of this.toolCallSessions) if (sid === p.sessionId) this.toolCallSessions.delete(id);
    }
    this.post({ ...p, type: method });
    // The UI tracks running turns per session (it disables Delete for them), not only the current one.
    if (adopted) this.post({ type: 'chat/turnState', sessionId: adopted, running: true });
    // A finished turn may have titled the session: refresh the switcher.
    if (method === 'chat/done') void this.postSessionList().catch(() => undefined);
  }

  /** Ends every turn the UI is waiting on with an error (the core went away). */
  private failActiveTurns(message: string): void {
    if (this.activeTurns.size === 0) return;
    const sessions = [...this.activeTurns];
    this.activeTurns.clear();
    this.toolCallSessions.clear();
    this.pendingCalls.clear();
    this.deps.onChatActiveChanged?.(false);
    for (const sessionId of sessions) this.post({ type: 'chat/done', sessionId, stopReason: 'error' });
    this.postError(message);
  }

  // ------------------------------------------------------------ UI → core

  private readonly onWindowMessage = (event: MessageEvent): void => {
    // Only our frame speaks for the UI (its origin is opaque: "null").
    if (!event.source || event.source !== this.iframe.contentWindow) return;
    void this.onUiMessage(event.data);
  };

  private async onUiMessage(raw: unknown): Promise<void> {
    if (typeof raw !== 'object' || raw === null || typeof (raw as Msg).type !== 'string') return;
    const msg = raw as Msg;
    try {
      switch (msg.type) {
        case 'ui/ready':
          return await this.onReady();
        case 'chat/send':
          return await this.send(String(msg.message ?? ''), this.validAttachments(msg.attachments));
        case 'chat/stop': {
          // The turn on screen, else the one running elsewhere (Stop shows only while one runs).
          const target =
            this.current && this.activeTurns.has(this.current) ? this.current : ([...this.activeTurns].pop() ?? this.current);
          if (target) await this.client.request('chat/stop', { sessionId: target });
          // Nothing to stop in the core: still end the UI's turn so Stop always unsticks the composer.
          else this.post({ type: 'chat/done', sessionId: '', stopReason: 'stopped' });
          return;
        }
        case 'chat/approve':
          return await this.approve(msg);
        case 'chat/newSession':
          return await this.newSession();
        case 'chat/switchSession':
          if (typeof msg.sessionId === 'string') await this.switchSession(msg.sessionId);
          return;
        case 'ui/insertAtCursor':
          if (!(this.deps.insertAtCursor?.(String(msg.text ?? '')) ?? false)) {
            this.postError('Nowhere to insert: open a notebook cell or an editor and place the cursor first.');
          }
          return;
        case 'ui/copy':
          await this.deps.copy?.(String(msg.text ?? ''));
          return;
        case 'ollama/start':
          this.deps.startOllama();
          return;
        case 'models/list':
          return await this.postModels();
        case 'model/select':
          return await this.inOrder('settings', () => this.selectModel(msg.kind, msg.name));
        case 'settings/get':
          return this.postSettings();
        case 'settings/set':
          return await this.inOrder('settings', () => this.applySettings(msg.patch));
        case 'session/delete':
          if (typeof msg.sessionId === 'string') {
            const id = msg.sessionId;
            await this.inOrder('sessions', () => this.deleteSession(id));
          }
          return;
        case 'session/clearAll':
          // clearSessions already told the UI about a failure.
          await this.inOrder('sessions', () => this.clearSessions().catch(() => undefined));
          return;
        case 'completion/stats':
          return await this.inOrder('completion', () => this.postStats());
        case 'completion/resetLearning':
          return await this.inOrder('completion', () => this.client.request('completion/resetLearning', {}));
        default:
          return; // ui/openDiff and unknown messages: nothing to do
      }
    } catch (e) {
      if (!isDisconnect(e)) this.postError(errorMessage(e));
    }
  }

  private async onReady(): Promise<void> {
    // Order matters: the UI keys tool cards by session, so the list goes first.
    try {
      await this.postSessionList();
      if (this.current) await this.postHistory(this.current);
      // Turns running in other sessions too, so the UI keeps their Delete buttons disabled.
      for (const sessionId of this.activeTurns) {
        if (sessionId !== this.current) this.post({ type: 'chat/turnState', sessionId, running: true });
      }
    } catch (e) {
      this.post({ type: 'session/list', sessions: [], current: this.current });
      if (!isDisconnect(e)) this.postError(`LocalPilot core is not available: ${errorMessage(e)}`);
    }
    if (this.status) this.post({ type: 'status', ...this.status });
    // The frame may have loaded before the theme's CSS did.
    this.postTheme(true);
    this.postActiveFile(true);
  }

  /** After a reconnect: the session list, then the current session's history (re-adopting it). */
  private async resync(): Promise<void> {
    try {
      await this.postSessionList();
      if (this.current) await this.postHistory(this.current);
    } catch {
      // A restarted core may not know the session any more; the UI keeps what it shows.
    }
  }

  private async send(message: string, attachments: unknown[]): Promise<void> {
    let sessionId = this.current;
    if (!sessionId) {
      try {
        sessionId = (await this.client.request<{ sessionId: string }>('chat/newSession', {})).sessionId;
      } catch (e) {
        // The UI is already showing a pending reply; end it (no session yet, so the UI accepts "").
        this.post({ type: 'chat/done', sessionId: this.current ?? '', stopReason: 'error' });
        this.postError(`Could not start a chat session: ${errorMessage(e)}`);
        return;
      }
      this.current = sessionId;
      const id = sessionId;
      // Announce the session before any of its turn events arrive.
      await this.postSessionList().catch(() => this.post({ type: 'session/list', sessions: this.sessions, current: id }));
    }
    this.startTurn(sessionId);
    try {
      await this.client.request('chat/send', { sessionId, message, attachments });
    } catch (e) {
      if ((e as { code?: unknown }).code === INVALID_PARAMS) {
        // That session's previous turn is still running; it will end with its own chat/done.
        this.postError('A reply is still in progress in this session. Wait for it or press Stop.');
        return;
      }
      if (isDisconnect(e)) return; // reported by the disconnect handler
      if (this.endTurn(sessionId)) this.post({ type: 'chat/done', sessionId, stopReason: 'error' });
      this.postError(`Could not send the message: ${errorMessage(e)}`);
    }
  }

  private async approve(msg: Msg): Promise<void> {
    const toolCallId = String(msg.toolCallId ?? '');
    const sessionId = this.toolCallSessions.get(toolCallId) ?? this.current;
    if (!sessionId) return;
    const params: Record<string, unknown> = { sessionId, toolCallId, decision: msg.decision };
    // editedArgs is already the complete args object (the core replaces args wholesale).
    if (msg.editedArgs !== undefined) params.editedArgs = msg.editedArgs;
    await this.client.request('chat/approve', params);
    // Decided (and the core took it): never offer it again after a history replay.
    this.pendingCalls.get(sessionId)?.delete(toolCallId);
  }

  private async switchSession(sessionId: string): Promise<void> {
    this.current = sessionId;
    this.post({ type: 'session/list', sessions: this.sessions, current: sessionId });
    await this.postHistory(sessionId);
  }

  // ------------------------------------------------------------ sessions, models, settings, stats

  /**
   * Core `chat/deleteSession`. On success the UI gets `session/deleted { sessionId, next }`
   * (next = the most recent remaining session) and then the refreshed `session/list`;
   * if the core refuses (the session's turn is running) it gets a `ui/error` saying so.
   * The server bridge drops the session's routing state and tells the other tabs.
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.client.request('chat/deleteSession', { sessionId });
    } catch (e) {
      // The core answers -32602 both for a running turn ("turn running …") and for an invalid id.
      const running = (e as { code?: unknown }).code === INVALID_PARAMS && /turn running/i.test(errorMessage(e));
      if (isDisconnect(e)) return;
      this.postError(
        running
          ? "That chat session's reply is still running. Wait for it or press Stop, then delete it."
          : `Could not delete the chat session: ${errorMessage(e)}`
      );
      return;
    }
    this.forgetSession(sessionId);
    const remaining = await this.fetchSessions().catch(() => this.sessions.filter((s) => s.sessionId !== sessionId));
    const next = remaining.find((s) => s.sessionId !== sessionId)?.sessionId ?? null;
    if (this.current === sessionId) this.current = next;
    this.post({ type: 'session/deleted', sessionId, next });
    this.sessions = remaining;
    this.post({ type: 'session/list', sessions: remaining, current: this.current });
  }

  /**
   * Core `chat/clearSessions`: one `session/deleted` per deleted session (next = the most
   * recent survivor, i.e. a session whose turn is running, or null), a notice for the kept
   * ones, then the refreshed `session/list`.
   */
  async clearSessions(): Promise<void> {
    const before = await this.fetchSessions().catch(() => this.sessions);
    let skipped: string[];
    try {
      ({ skipped } = await this.client.request<{ deleted: number; skipped: string[] }>('chat/clearSessions', {}));
    } catch (e) {
      if (!isDisconnect(e)) this.postError(`Could not clear the chat sessions: ${errorMessage(e)}`);
      throw e;
    }
    skipped = Array.isArray(skipped) ? skipped : [];
    const kept = skipped;
    const after = await this.fetchSessions().catch(() => before.filter((s) => kept.includes(s.sessionId)));
    const survivors = new Set(after.map((s) => s.sessionId));
    const next = after[0]?.sessionId ?? null;
    for (const { sessionId } of before) {
      if (survivors.has(sessionId)) continue;
      this.forgetSession(sessionId);
      if (this.current === sessionId) this.current = next;
      this.post({ type: 'session/deleted', sessionId, next });
    }
    if (skipped.length > 0) {
      const n = skipped.length;
      this.postError(`${n} session${n === 1 ? '' : 's'} with a running reply ${n === 1 ? 'was' : 'were'} kept.`);
    }
    this.sessions = after;
    this.post({ type: 'session/list', sessions: after, current: this.current });
  }

  /** Another tab deleted sessions (`localpilot/sessionsChanged`): drop the ones that are gone here too. */
  private async sessionsChangedElsewhere(): Promise<void> {
    let after: SessionSummary[];
    try {
      after = await this.fetchSessions();
    } catch {
      return;
    }
    const survivors = new Set(after.map((s) => s.sessionId));
    const next = after[0]?.sessionId ?? null;
    for (const { sessionId } of this.sessions) {
      if (survivors.has(sessionId)) continue;
      this.forgetSession(sessionId);
      if (this.current === sessionId) this.current = next;
      this.post({ type: 'session/deleted', sessionId, next });
    }
    if (this.current !== null && !survivors.has(this.current)) this.current = next;
    this.sessions = after;
    this.post({ type: 'session/list', sessions: after, current: this.current });
  }

  /** Runs `fn` after every earlier call with the same `topic` has settled. */
  private inOrder<T>(topic: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(topic) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(topic, settled);
    void settled.then(() => {
      if (this.chains.get(topic) === settled) this.chains.delete(topic);
    });
    return run;
  }

  /** `models/list`: core `ollama/models` + the configured choices; `ollama: "down"` with `error` when that fails. */
  async postModels(): Promise<void> {
    let msg: Msg;
    try {
      const { models } = await this.client.request<{ models: ModelInfo[] }>('ollama/models', {});
      this.knownModels = Array.isArray(models) ? models : [];
      // Ollama answered, so a stale "down" status no longer applies; "modelMissing" still does.
      const ollama = this.status?.ollama === 'modelMissing' ? 'modelMissing' : 'ok';
      msg = { type: 'models/list', models: this.knownModels, current: this.currentModels(), ollama };
    } catch (e) {
      msg = { type: 'models/list', models: [], current: this.currentModels(), ollama: 'down', error: errorMessage(e) };
    }
    this.post(msg);
  }

  private currentModels(): { chat: string; completion: string } {
    const s = this.deps.settings?.();
    return { chat: s?.chatModel ?? '', completion: s?.completionModel ?? '' };
  }

  /**
   * `model/select`: writes the chat/completion model setting (the core restarts), then always answers
   * `models/list`. Only a name from the last-known installed list (fetched first if there is none yet)
   * or the current setting is written: the frame is not trusted to name arbitrary models.
   */
  private async selectModel(kind: unknown, name: unknown): Promise<void> {
    if (isModelKind(kind) && typeof name === 'string' && name.trim()) {
      const model = name.trim();
      if (!this.deps.setSetting) {
        this.postError('Changing models is not available here.');
      } else if (await this.isSelectable(kind, model)) {
        try {
          await this.deps.setSetting(MODEL_SETTING[kind], model);
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
    let known = this.knownModels;
    if (!known) {
      try {
        known = (await this.client.request<{ models: ModelInfo[] }>('ollama/models', {})).models;
        this.knownModels = known;
      } catch {
        return false;
      }
    }
    return Array.isArray(known) && known.some((m) => m.name === model);
  }

  private postSettings(): void {
    const s = this.deps.settings?.();
    if (!s) return;
    this.post({
      type: 'settings/current',
      settings: {
        completionModel: s.completionModel,
        completionMaxTokens: s.completionMaxTokens,
        completionDebounceMs: s.completionDebounceMs,
        completionContextTokens: s.completionContextTokens,
        adaptiveCompletions: s.adaptiveCompletions
      }
    });
  }

  /**
   * `settings/set { patch }`: writes the panel's keys (others, including `completionModel`, are
   * ignored; numbers are rounded and clamped to the schema minimums), then always answers
   * `settings/current`.
   */
  private async applySettings(patch: unknown): Promise<void> {
    const p = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>;
    const writes: Array<[keyof Settings, unknown]> = [];
    for (const [key, min] of Object.entries(PANEL_NUMBERS) as Array<[keyof typeof PANEL_NUMBERS, number]>) {
      const v = p[key];
      if (typeof v === 'number' && Number.isFinite(v)) writes.push([key, Math.max(min, Math.round(v))]);
    }
    for (const key of PANEL_BOOLEANS) if (typeof p[key] === 'boolean') writes.push([key, p[key]]);
    for (const [key, value] of writes) {
      try {
        if (!this.deps.setSetting) throw new Error('settings are read-only here');
        await this.deps.setSetting(key, value);
      } catch (e) {
        this.postError(`Could not save ${key}: ${errorMessage(e)}`);
      }
    }
    this.postSettings();
  }

  private async postStats(): Promise<void> {
    const stats = await this.client.request('completion/stats', {});
    this.post({ type: 'completion/stats', stats });
  }

  // ------------------------------------------------------------ helpers

  private async fetchSessions(): Promise<SessionSummary[]> {
    const { sessions } = await this.client.request<{ sessions: SessionSummary[] }>('chat/listSessions', {});
    return Array.isArray(sessions) ? sessions : [];
  }

  /** Drops the widget's per-session bookkeeping for a deleted session. */
  private forgetSession(sessionId: string): void {
    this.pendingCalls.delete(sessionId);
    for (const [id, sid] of this.toolCallSessions) if (sid === sessionId) this.toolCallSessions.delete(id);
    if (this.endTurn(sessionId)) this.post({ type: 'chat/done', sessionId, stopReason: 'stopped' });
  }

  private async postSessionList(): Promise<void> {
    const { sessions } = await this.client.request<{ sessions: SessionSummary[] }>('chat/listSessions', {});
    this.sessions = Array.isArray(sessions) ? sessions : [];
    if (this.current === null && this.sessions.length > 0) this.current = this.sessions[0].sessionId;
    this.post({ type: 'session/list', sessions: this.sessions, current: this.current });
  }

  private async postHistory(sessionId: string): Promise<void> {
    const result = await this.client.request<{ sessionId: string; messages: unknown[] }>('chat/history', { sessionId });
    if (this.current !== sessionId) return; // switched again meanwhile
    this.post({ type: 'session/history', sessionId, messages: result.messages });
    // History shows tool calls as settled: re-offer those still awaiting a decision,
    // and tell the UI whether this session's turn is still running (Stop).
    for (const call of this.pendingCalls.get(sessionId)?.values() ?? []) this.post({ ...call, type: 'chat/toolCall' });
    this.post({ type: 'chat/turnState', sessionId, running: this.activeTurns.has(sessionId) });
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
   * Attachments from the UI, kept only if they name a document the core has
   * (a synced notebook cell or file); a malformed range is dropped, the
   * attachment kept.
   */
  private validAttachments(raw: unknown): Array<{ uri: string; range?: Range }> {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ uri: string; range?: Range }> = [];
    for (const a of raw) {
      if (typeof a !== 'object' || a === null || typeof (a as { uri?: unknown }).uri !== 'string') continue;
      const { uri, range } = a as { uri: string; range?: unknown };
      if (!(this.deps.isSyncedUri?.(uri) ?? false)) continue;
      out.push(isRange(range) ? { uri, range } : { uri });
    }
    return out;
  }

  private postActiveFile(force = false): void {
    let active: ActiveFile | undefined;
    try {
      active = this.deps.activeFile?.();
    } catch {
      active = undefined;
    }
    const msg: Msg = { type: 'ui/activeFile', uri: active?.uri ?? null };
    if (active?.uri && isRange(active.selection)) {
      const s = active.selection;
      msg.selection = { start: { line: s.start.line, character: s.start.character }, end: { line: s.end.line, character: s.end.character } };
    }
    const key = JSON.stringify(msg);
    if (!force && key === this.lastActiveFile) return;
    this.lastActiveFile = key;
    this.post(msg);
  }

  private currentTheme(): Record<string, string> {
    try {
      return safeThemeVars(this.deps.themeVars?.());
    } catch {
      return {};
    }
  }

  private postTheme(force = false): void {
    if (!this.deps.themeVars) return;
    const vars = this.currentTheme();
    const key = JSON.stringify(vars);
    if (!force && key === this.lastTheme) return;
    this.lastTheme = key;
    this.post({ type: 'ui/theme', vars });
  }

  private postError(message: string): void {
    this.post({ type: 'ui/error', message });
  }

  /** To the frame's UI; its origin is opaque, so `"*"` is the only target that matches. */
  private post(msg: Msg): void {
    this.iframe.contentWindow?.postMessage(msg, '*');
  }
}

const isPosition = (p: unknown): boolean =>
  typeof p === 'object' &&
  p !== null &&
  Number.isInteger((p as { line?: unknown }).line) &&
  Number.isInteger((p as { character?: unknown }).character);

function isRange(r: unknown): r is Range {
  return typeof r === 'object' && r !== null && isPosition((r as { start?: unknown }).start) && isPosition((r as { end?: unknown }).end);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
