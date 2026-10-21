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
  /** Some gain arrived as one multi-character edit with a word in it: VS Code's accept-next-word/line (or Tab, which also runs the command). */
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

const WORD = /\w/;

/** `gained` holds at least one whole word of `suggestion` (it does not stop mid-word). */
function hasWholeWord(gained: string, suggestion: string): boolean {
  if (!WORD.test(gained)) return false;
  const last = gained[gained.length - 1];
  const next = suggestion[gained.length];
  if (next === undefined || !WORD.test(last) || !WORD.test(next)) return true;
  // Stops mid-word: count only the words before the one being typed.
  return WORD.test(gained.replace(/\w+$/, ""));
}

/**
 * Inline (ghost text) completions from the core. Each call supersedes the
 * previous one: an in-flight request gets `completion/cancel`, and a shown
 * item nothing was taken from gets `completion/rejected`. Accepting runs
 * `ACCEPT_COMMAND` → `reportAccepted` → `completion/accepted`.
 *
 * Shown items are also watched through document changes
 * (`onDidChangeTextDocument`), since VS Code runs no command for a partial
 * accept: once the text between the item's surroundings stops being a prefix
 * of the suggestion, or {@link OUTCOME_IDLE_MS} pass without progress, the
 * outcome goes out as `completion/outcome`:
 * - `typedThrough`: the whole suggestion arrived one key at a time;
 * - `partial` (with `acceptedText`): part of it arrived through accept-next-word/line
 *   (a multi-character edit with a word in it), or at least one whole word of it was typed;
 * - otherwise `completion/rejected`.
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
    for (const t of [...this.tracked.values()]) {
      if (t.uri !== uri) continue;
      text ??= e.document.getText();
      const fits = text.length >= t.before.length + t.after.length && text.startsWith(t.before) && text.endsWith(t.after);
      const middle = fits ? text.slice(t.before.length, text.length - t.after.length) : undefined;
      if (middle === undefined || !t.suggestion.startsWith(middle)) {
        this.finish(t);
        continue;
      }
      if (middle.length > t.gained.length && middle.startsWith(t.gained)) {
        const added = middle.slice(t.gained.length);
        if (added.length > 1 && WORD.test(added)) t.chunked = true;
      }
      t.gained = middle;
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
    if (progressed && gained === suggestion && !t.chunked) {
      this.client.notify("completion/outcome", { requestId, outcome: "typedThrough" });
    } else if (progressed && (t.chunked || hasWholeWord(gained, suggestion))) {
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
