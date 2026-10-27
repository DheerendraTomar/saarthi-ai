// HostBridge: how the chat UI talks to whichever host embeds it
// (VS Code webview, JetBrains JCEF, a parent page's <iframe> such as the
// JupyterLab sidebar, or an in-memory bridge for tests).
import type {
  Attachment,
  ChatDone,
  ChatToken,
  ChatToolCall,
  ChatToolResult,
  Decision,
  CompletionStats,
  HistoryMessage,
  JsonValue,
  ModelInfo,
  OllamaState,
  Range,
  SessionSummary,
  StatusNotification,
} from "./protocol";

export type ModelKind = "chat" | "completion";

/** The completion settings the settings panel edits (host settings, e.g. `localpilot.*` in VS Code). */
export interface CompletionSettings {
  completionModel: string;
  completionMaxTokens: number;
  completionDebounceMs: number;
  completionContextTokens: number;
  adaptiveCompletions: boolean;
}

/** What `settings/set` may change (the completion model is set with `model/select`). */
export type SettingsPatch = Partial<Omit<CompletionSettings, "completionModel">>;

/** Messages the UI sends to the host. */
export type UiToHost =
  | { type: "chat/send"; message: string; attachments: Attachment[] }
  | { type: "chat/stop" }
  | { type: "chat/approve"; toolCallId: string; decision: Decision; editedArgs?: JsonValue }
  | { type: "chat/newSession" }
  | { type: "chat/switchSession"; sessionId: string }
  | { type: "ui/ready" }
  | { type: "ui/insertAtCursor"; text: string }
  | { type: "ui/copy"; text: string }
  | { type: "ui/openDiff"; toolCallId: string }
  | { type: "ollama/start" }
  /** Ask for a fresh `models/list` (host calls core `ollama/models`). */
  | { type: "models/list" }
  /** Persist the chat or completion model setting (the host restarts the core as needed). */
  | { type: "model/select"; kind: ModelKind; name: string }
  /** Ask for `settings/current`. */
  | { type: "settings/get" }
  /** Persist the given settings; the host answers with `settings/current`. The completion model goes through `model/select`. */
  | { type: "settings/set"; patch: SettingsPatch }
  /** Core `chat/deleteSession`; the host answers `session/deleted` or `ui/error` (turn running). */
  | { type: "session/delete"; sessionId: string }
  /** Core `chat/clearSessions` (already confirmed by the user). */
  | { type: "session/clearAll" }
  /** Ask for `completion/stats`. */
  | { type: "completion/stats" }
  /** Core `completion/resetLearning`; the UI follows it with `completion/stats`. */
  | { type: "completion/resetLearning" };

/** Messages the host sends to the UI: core notifications verbatim + host-originated ones. */
export type HostToUi =
  | ({ type: "chat/token" } & ChatToken)
  | ({ type: "chat/toolCall" } & ChatToolCall)
  | ({ type: "chat/toolResult" } & ChatToolResult)
  | ({ type: "chat/done" } & ChatDone)
  | ({ type: "status" } & StatusNotification)
  /** Host-originated: whether `sessionId` has a turn in progress (sent after `session/history`, so Stop shows for a running turn). */
  | { type: "chat/turnState"; sessionId: string; running: boolean }
  | { type: "session/list"; sessions: SessionSummary[]; current: string | null }
  | { type: "session/history"; sessionId: string; messages: HistoryMessage[] }
  | { type: "ui/activeFile"; uri: string | null; selection?: Range }
  | { type: "ui/error"; message: string }
  /** Host-originated: theme colours/fonts as `--vscode-*` custom properties (hosts that cannot share CSS variables, e.g. an iframe). */
  | { type: "ui/theme"; vars: Record<string, string> }
  /**
   * Host-originated: installed models and the configured choices. When Ollama
   * is unreachable send `models: []` with `ollama: "down"` (and `error`); the
   * UI keeps showing the last-known list.
   */
  | {
      type: "models/list";
      models: ModelInfo[];
      current: { chat: string; completion: string };
      ollama: OllamaState;
      error?: string;
    }
  | { type: "settings/current"; settings: CompletionSettings }
  | { type: "completion/stats"; stats: CompletionStats }
  /**
   * Host-originated: `sessionId` was deleted. `next` is the most recent
   * remaining session (or `null`); if the deleted one was current the UI
   * switches to `next` (`chat/switchSession`) or starts a new one.
   */
  | { type: "session/deleted"; sessionId: string; next: string | null };

export interface HostBridge {
  post(msg: UiToHost): void;
  /** Subscribe to host messages; returns an unsubscribe function. */
  onMessage(cb: (msg: HostToUi) => void): () => void;
  getState<T>(): T | undefined;
  setState<T>(s: T): void;
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}

interface CefQueryArgs {
  request: string;
  persistent?: boolean;
  onSuccess?: (response: string) => void;
  onFailure?: (code: number, message: string) => void;
}

type HostWindow = Window & {
  acquireVsCodeApi?: () => VsCodeApi;
  cefQuery?: (args: CefQueryArgs) => number;
};

const THEME_VAR = /^--vscode-[A-Za-z0-9.-]+$/;

/**
 * Applies a `ui/theme` message: sets each `--vscode-*` custom property on
 * `root` (default: `<html>`), which styles.css reads. Other names and
 * non-string values are ignored.
 */
export function applyTheme(vars: Record<string, string>, root: HTMLElement = document.documentElement): void {
  if (!vars || typeof vars !== "object") return;
  for (const [name, value] of Object.entries(vars)) {
    if (THEME_VAR.test(name) && typeof value === "string") root.style.setProperty(name, value);
  }
}

/** Listens for host → UI messages delivered as `window` "message" events. */
function onWindowMessage(cb: (msg: HostToUi) => void): () => void {
  const listener = (e: MessageEvent) => {
    const data: unknown = e.data;
    if (data && typeof data === "object" && typeof (data as { type?: unknown }).type === "string") {
      cb(data as HostToUi);
    }
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

/** VS Code webview: `acquireVsCodeApi()` (callable once) for posts and persisted state. */
class VsCodeBridge implements HostBridge {
  constructor(private readonly api: VsCodeApi) {}
  post(msg: UiToHost): void {
    this.api.postMessage(msg);
  }
  onMessage(cb: (msg: HostToUi) => void): () => void {
    return onWindowMessage(cb);
  }
  getState<T>(): T | undefined {
    return (this.api.getState() ?? undefined) as T | undefined;
  }
  setState<T>(s: T): void {
    this.api.setState(s);
  }
}

/**
 * JetBrains JCEF: posts go through `window.cefQuery({ request: JSON })`; the
 * host delivers messages via `window.postMessage(msg, "*")`. State is kept in
 * memory (JCEF browsers live as long as the tool window).
 */
class CefBridge implements HostBridge {
  private state: unknown = undefined;
  constructor(private readonly cefQuery: (args: CefQueryArgs) => number) {}
  post(msg: UiToHost): void {
    this.cefQuery({ request: JSON.stringify(msg) });
  }
  onMessage(cb: (msg: HostToUi) => void): () => void {
    return onWindowMessage(cb);
  }
  getState<T>(): T | undefined {
    return this.state as T | undefined;
  }
  setState<T>(s: T): void {
    this.state = s;
  }
}

/**
 * Embedded in another page's `<iframe>` (JupyterLab): posts go to the parent
 * with `postMessage(msg, "*")` — the frame is sandboxed without
 * `allow-same-origin`, so its origin is opaque and no narrower target
 * origin can match — and only messages whose `source` is that parent are
 * accepted. State is kept in memory (the frame lives as long as the panel).
 */
export class IframeBridge implements HostBridge {
  private state: unknown = undefined;
  constructor(private readonly parent: Window = window.parent) {}
  post(msg: UiToHost): void {
    this.parent.postMessage(msg, "*");
  }
  onMessage(cb: (msg: HostToUi) => void): () => void {
    const listener = (e: MessageEvent) => {
      if (e.source !== this.parent) return;
      const data: unknown = e.data;
      if (data && typeof data === "object" && typeof (data as { type?: unknown }).type === "string") {
        cb(data as HostToUi);
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }
  getState<T>(): T | undefined {
    return this.state as T | undefined;
  }
  setState<T>(s: T): void {
    this.state = s;
  }
}

/** In-memory bridge for tests and standalone dev (`vite dev`). */
export class TestBridge implements HostBridge {
  readonly sent: UiToHost[] = [];
  private readonly listeners = new Set<(msg: HostToUi) => void>();
  private state: unknown = undefined;

  post(msg: UiToHost): void {
    this.sent.push(msg);
  }
  onMessage(cb: (msg: HostToUi) => void): () => void {
    // Wrap so the same callback can be subscribed twice independently.
    const entry = (msg: HostToUi) => cb(msg);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }
  /** Simulate a host → UI message. */
  emit(msg: HostToUi): void {
    for (const l of [...this.listeners]) l(msg);
  }
  getState<T>(): T | undefined {
    return this.state as T | undefined;
  }
  setState<T>(s: T): void {
    this.state = s;
  }
}

/**
 * Picks the bridge for the current host: VS Code → JCEF → parent page (we are
 * in an iframe) → TestBridge. VS Code webviews are iframes too, hence the order.
 */
export function createHostBridge(): HostBridge {
  const w = window as HostWindow;
  if (typeof w.acquireVsCodeApi === "function") {
    return new VsCodeBridge(w.acquireVsCodeApi());
  }
  if (typeof w.cefQuery === "function") {
    return new CefBridge(w.cefQuery.bind(w));
  }
  if (w.parent && w.parent !== w) {
    return new IframeBridge(w.parent);
  }
  return new TestBridge();
}
