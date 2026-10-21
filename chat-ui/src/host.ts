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
  HistoryMessage,
  JsonValue,
  OllamaPullProgress,
  Range,
  SessionSummary,
  StatusNotification,
} from "./protocol";

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
  | { type: "ollama/pull"; model: string };

/** Messages the host sends to the UI: core notifications verbatim + host-originated ones. */
export type HostToUi =
  | ({ type: "chat/token" } & ChatToken)
  | ({ type: "chat/toolCall" } & ChatToolCall)
  | ({ type: "chat/toolResult" } & ChatToolResult)
  | ({ type: "chat/done" } & ChatDone)
  | ({ type: "status" } & StatusNotification)
  | ({ type: "ollama/pullProgress" } & OllamaPullProgress)
  /** Host-originated: whether `sessionId` has a turn in progress (sent after `session/history`, so Stop shows for a running turn). */
  | { type: "chat/turnState"; sessionId: string; running: boolean }
  | { type: "session/list"; sessions: SessionSummary[]; current: string | null }
  | { type: "session/history"; sessionId: string; messages: HistoryMessage[] }
  | { type: "ui/activeFile"; uri: string | null; selection?: Range }
  | { type: "ui/error"; message: string }
  /** Host-originated: theme colours/fonts as `--vscode-*` custom properties (hosts that cannot share CSS variables, e.g. an iframe). */
  | { type: "ui/theme"; vars: Record<string, string> };

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
