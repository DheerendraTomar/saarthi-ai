// Fakes for the chat view tests: a WebviewView that records posts, and a core
// client whose requests are answered by a test-supplied function.
import type * as vscode from "vscode";
import type { CoreState } from "../../src/rpc/coreClient";
import { EventEmitter } from "../mocks/vscode";

export interface FakeWebviewView {
  view: vscode.WebviewView;
  webview: { html: string; options: unknown; cspSource: string };
  /** Every message the host posted to the webview, in order. */
  posted: Array<Record<string, unknown>>;
  /** Simulates the UI posting `msg` to the host. */
  send(msg: unknown): void;
}

export function fakeWebviewView(): FakeWebviewView {
  const received = new EventEmitter<unknown>();
  const disposed = new EventEmitter<void>();
  const posted: Array<Record<string, unknown>> = [];
  const webview = {
    html: "",
    options: {} as unknown,
    cspSource: "vscode-resource:",
    async postMessage(msg: Record<string, unknown>) {
      posted.push(msg);
      return true;
    },
    onDidReceiveMessage: received.event,
    asWebviewUri: (u: unknown) => u,
  };
  const view = { webview, onDidDispose: disposed.event, visible: true, show() {} };
  return { view: view as unknown as vscode.WebviewView, webview, posted, send: (msg) => received.fire(msg) };
}

export interface RecordedRequest {
  method: string;
  params: unknown;
}

export class FakeChatClient {
  readonly requests: RecordedRequest[] = [];
  private readonly handlers = new Map<string, Set<(p: unknown) => void>>();
  readonly states = new EventEmitter<CoreState>();
  readonly onDidChangeState = this.states.event;
  state: CoreState = "ready";

  constructor(public respond: (method: string, params: unknown) => unknown = () => ({})) {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    return (await this.respond(method, params)) as T;
  }

  onNotification(method: string, handler: (p: unknown) => void) {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return { dispose: () => set.delete(handler) };
  }

  /** Delivers a core notification to every handler. */
  emit(method: string, params: unknown): void {
    for (const h of [...(this.handlers.get(method) ?? [])]) h(params);
  }

  of(method: string): unknown[] {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }
}

/** Polls `cond` until it holds (or fails after `timeoutMs`). */
export async function waitFor(cond: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
