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

/** How long a partly taken suggestion may sit without progress before its outcome is reported. */
export const OUTCOME_IDLE_MS = 2000;
/** At most this many shown suggestions are watched at once (the oldest is reported first). */
const MAX_TRACKED = 8;

/** A shown suggestion, watched through document changes until its outcome is known. */
interface Tracked {
  requestId: string;
  uri: string;
  /** Document text before / after the item's range when it was shown. */
  before: string;
  after: string;
  suggestion: string;
  /** The longest prefix of `suggestion` now between `before` and `after`. */
  gained: string;
  /** What was there when shown (progress means gaining more). */
  baseline: number;
  /** Some gain arrived as a chunk (one edit of ≥ 2 characters): accept-next-word/line, Tab, or a matching IntelliSense accept. */
  chunked: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Character offset of a line/character position in `text`. */
function offsetAt(text: string, line: number, character: number): number {
  let offset = 0;
  for (let l = 0; l < line; l++) {
    const nl = text.indexOf("\n", offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
  }
  const eol = text.indexOf("\n", offset);
  return Math.min(offset + character, eol < 0 ? text.length : eol);
}

/**
 * The part of `middle` that is a prefix of `suggestion`, allowing trailing
 * auto-closed brackets/quotes the suggestion still has later (typing `foo(`
 * gives `foo()` while the suggestion is `foo(1)`); undefined once it diverged.
 */
function matchedPrefix(middle: string, suggestion: string): string | undefined {
  if (suggestion.startsWith(middle)) return middle;
  const closers = /[)\]}"'`]+$/.exec(middle);
  if (!closers) return undefined;
  const prefix = middle.slice(0, closers.index);
  if (!suggestion.startsWith(prefix)) return undefined;
  let rest = suggestion.slice(prefix.length);
  for (const c of closers[0]) {
    const i = rest.indexOf(c);
    if (i < 0) return undefined;
    rest = rest.slice(i + 1);
  }
  return prefix;
}

/**
 * Inline (ghost text) completions from the core. Each call supersedes the
 * previous one: an in-flight request gets `completion/cancel`, and a shown
 * item nothing was taken from gets `completion/rejected`. Accepting runs
 * `ACCEPT_COMMAND` → `reportAccepted` → `completion/accepted`.
 *
 * Shown items are also watched through document changes
 * (`onDidChangeTextDocument`), since VS Code runs no command for a partial
 * accept. A "chunk" is one edit inserting ≥ 2 characters (with a letter or
 * digit) that extends the suggestion: accept-next-word/line, Tab — and, a
 * known bias, an IntelliSense accept that matches the ghost text. Once the
 * text between the item's surroundings stops matching the suggestion, or
 * {@link OUTCOME_IDLE_MS} pass without progress, the outcome goes out:
 * - whole suggestion (up to trailing whitespace) with a chunk → `completion/outcome accepted`
 *   (stepped through with accept-next-word/line; Tab reports `completion/accepted` first);
 * - whole suggestion, key by key → `completion/outcome typedThrough`;
 * - part of it with a chunk → `completion/outcome partial` with `acceptedText`;
 * - otherwise (untouched, or only typed by hand) → `completion/rejected`.
 * The core serves one item per request; the first item is the one watched.
 */
export class InlineProvider implements vscode.InlineCompletionItemProvider {
  private readonly debouncer: Debouncer;
  private seq = 0;
  private inflight?: { requestId: string; cancel: () => void };
  private readonly tracked = new Map<string, Tracked>();
  /** Request ids whose outcome was sent (so a late accept command is not reported twice). */
  private readonly reported = new Set<string>();

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

    this.track(document, requestId, result.items[0]);
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
    const t = this.tracked.get(requestId);
    if (t) this.untrack(t);
    if (!this.markReported(requestId)) return;
    this.client.notify("completion/accepted", { requestId });
  }

  /** Feed of `workspace.onDidChangeTextDocument`: follows the shown suggestions in that document. */
  onDidChangeTextDocument(e: vscode.TextDocumentChangeEvent): void {
    if (this.tracked.size === 0) return;
    const uri = e.document.uri.toString();
    let text: string | undefined;
    const inserted = e.contentChanges.length === 1 ? e.contentChanges[0].text : "";
    for (const t of [...this.tracked.values()]) {
      if (t.uri !== uri) continue;
      text ??= e.document.getText();
      const fits = text.length >= t.before.length + t.after.length && text.startsWith(t.before) && text.endsWith(t.after);
      const middle = fits ? text.slice(t.before.length, text.length - t.after.length) : undefined;
      const prefix = middle === undefined ? undefined : matchedPrefix(middle, t.suggestion);
      if (prefix === undefined) {
        this.finish(t);
        continue;
      }
      if (prefix.length >= t.gained.length + 2 && /\w/.test(inserted) && inserted.length >= 2) t.chunked = true;
      t.gained = prefix;
      this.armTimer(t);
    }
  }

  /** Reports nothing more; clears the watch timers. */
  dispose(): void {
    for (const t of this.tracked.values()) clearTimeout(t.timer);
    this.tracked.clear();
  }

  private track(document: vscode.TextDocument, requestId: string, item: { text: string; range: WireRange }): void {
    if (!item.text) return;
    const text = document.getText();
    const start = offsetAt(text, item.range.start.line, item.range.start.character);
    const end = Math.max(start, offsetAt(text, item.range.end.line, item.range.end.character));
    const existing = text.slice(start, end);
    const gained = item.text.startsWith(existing) ? existing : "";
    this.tracked.set(requestId, {
      requestId,
      uri: document.uri.toString(),
      before: text.slice(0, start),
      after: text.slice(end),
      suggestion: item.text,
      gained,
      baseline: gained.length,
      chunked: false,
    });
    for (const t of this.tracked.values()) {
      if (this.tracked.size <= MAX_TRACKED) break;
      this.finish(t);
    }
  }

  private armTimer(t: Tracked): void {
    clearTimeout(t.timer);
    t.timer = setTimeout(() => this.finish(t), OUTCOME_IDLE_MS);
  }

  private untrack(t: Tracked): void {
    clearTimeout(t.timer);
    this.tracked.delete(t.requestId);
  }

  /** Stops watching `t` and reports what was taken from it. */
  private finish(t: Tracked): void {
    this.untrack(t);
    if (!this.markReported(t.requestId)) return;
    const { requestId, gained, suggestion } = t;
    const progressed = gained.length > t.baseline;
    // Trailing whitespace/newlines are not required (Enter auto-indents differently).
    const whole = gained.trimEnd() === suggestion.trimEnd();
    if (progressed && whole && t.chunked) {
      this.client.notify("completion/outcome", { requestId, outcome: "accepted", acceptedText: suggestion });
    } else if (progressed && whole) {
      this.client.notify("completion/outcome", { requestId, outcome: "typedThrough" });
    } else if (progressed && t.chunked) {
      this.client.notify("completion/outcome", { requestId, outcome: "partial", acceptedText: gained });
    } else {
      this.client.notify("completion/rejected", { requestId });
    }
  }

  /** True the first time per request id. */
  private markReported(requestId: string): boolean {
    if (this.reported.has(requestId)) return false;
    this.reported.add(requestId);
    if (this.reported.size > 256) this.reported.delete(this.reported.values().next().value as string);
    return true;
  }

  private supersede(): void {
    this.inflight?.cancel();
    this.inflight = undefined;
    // Untouched suggestions are rejected now; partly taken ones stay watched until they settle.
    for (const t of [...this.tracked.values()]) if (t.gained.length <= t.baseline) this.finish(t);
  }
}
