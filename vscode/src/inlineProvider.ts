import * as vscode from "vscode";
import { syncUri, type WireRange } from "./documentSync";
import type { CancellationTokenLike, CoreClient } from "./rpc/coreClient";
import type { Settings } from "./settings";

/** Command attached to every item; VS Code runs it when the user accepts the ghost text (registered in commands.ts → `reportAccepted`). */
export const ACCEPT_COMMAND = "localpilot.completionAccepted";

/** The part of `CoreClient` that completions use (a fake in tests). */
export type CompletionClient = Pick<CoreClient, "request" | "notify">;

interface CompletionResult {
  items: Array<{ text: string; range: WireRange }>;
}

type Disposable = { dispose(): unknown };

/** A cancellation token we can trigger ourselves (structurally a `vscode.CancellationToken`). */
class CancelSource implements CancellationTokenLike {
  isCancellationRequested = false;
  private readonly listeners = new Set<() => unknown>();
  onCancellationRequested(listener: () => unknown) {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }
  cancel(): void {
    if (this.isCancellationRequested) return;
    this.isCancellationRequested = true;
    for (const l of [...this.listeners]) l();
  }
}

/**
 * Trailing-edge debouncer. `wait()` resolves `true` once `delayMs` passes with
 * no newer `wait()`; a superseded, cancelled (`cancel()`) or token-cancelled
 * waiter resolves `false` — waiters always settle, never hang.
 */
export class Debouncer {
  private pending?: (fired: boolean) => void;

  constructor(public delayMs: number) {}

  wait(token?: CancellationTokenLike): Promise<boolean> {
    this.cancel();
    if (token?.isCancellationRequested) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const settle = (fired: boolean) => {
        if (this.pending !== settle) return;
        this.pending = undefined;
        clearTimeout(timer);
        sub?.dispose();
        resolve(fired);
      };
      this.pending = settle;
      const timer = setTimeout(() => settle(true), this.delayMs);
      const sub: Disposable | undefined = token?.onCancellationRequested(() => settle(false));
    });
  }

  cancel(): void {
    this.pending?.(false);
  }
}

/**
 * Inline (ghost text) completions from the core. Each call supersedes the
 * previous one: an in-flight request gets `completion/cancel`, and shown but
 * unaccepted items get `completion/rejected`. Accepting runs `ACCEPT_COMMAND`
 * → `reportAccepted` → `completion/accepted`.
 */
export class InlineProvider implements vscode.InlineCompletionItemProvider {
  private readonly debouncer: Debouncer;
  private seq = 0;
  private inflight?: { requestId: string; cancel: () => void };
  private shown?: string;

  constructor(
    private readonly client: CompletionClient,
    private settings: Settings,
  ) {
    this.debouncer = new Debouncer(settings.completionDebounceMs);
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    if (!this.settings.completionsEnabled) return [];
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const uri = root === undefined ? undefined : syncUri(document, root);
    if (!uri) return [];

    this.supersede();
    this.debouncer.delayMs = this.settings.completionDebounceMs;
    if (!(await this.debouncer.wait(token))) return [];

    const requestId = String(++this.seq);
    const abort = new CancelSource();
    const inflight = {
      requestId,
      cancel: () => {
        if (abort.isCancellationRequested) return;
        abort.cancel();
        this.client.notify("completion/cancel", { requestId });
      },
    };
    this.inflight = inflight;
    const sub = token.onCancellationRequested(inflight.cancel);
    let result: CompletionResult;
    try {
      result = await this.client.request<CompletionResult>(
        "completion/request",
        { uri, position: { line: position.line, character: position.character }, requestId },
        abort,
      );
    } catch {
      return []; // cancelled, superseded, or the core is not running
    } finally {
      sub.dispose();
      if (this.inflight === inflight) this.inflight = undefined;
    }
    if (abort.isCancellationRequested || token.isCancellationRequested || !result?.items?.length) return [];

    this.shown = requestId;
    const command = { command: ACCEPT_COMMAND, title: "LocalPilot: completion accepted", arguments: [requestId] };
    return result.items.map(
      (item) =>
        new vscode.InlineCompletionItem(
          item.text,
          new vscode.Range(
            new vscode.Position(item.range.start.line, item.range.start.character),
            new vscode.Position(item.range.end.line, item.range.end.character),
          ),
          command,
        ),
    );
  }

  /** Called through `ACCEPT_COMMAND` when the user accepts an item. */
  reportAccepted(requestId: string): void {
    if (this.shown === requestId) this.shown = undefined;
    this.client.notify("completion/accepted", { requestId });
  }

  private supersede(): void {
    this.inflight?.cancel();
    this.inflight = undefined;
    if (this.shown !== undefined) {
      this.client.notify("completion/rejected", { requestId: this.shown });
      this.shown = undefined;
    }
  }
}
