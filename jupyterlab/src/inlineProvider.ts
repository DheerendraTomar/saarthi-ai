import type {
  CompletionHandler,
  IInlineCompletionContext,
  IInlineCompletionItem,
  IInlineCompletionList,
  IInlineCompletionProvider
} from '@jupyterlab/completer';
import { Text } from '@jupyterlab/coreutils';
import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import type { IDisposable } from '@lumino/disposable';
import type { ISignal } from '@lumino/signaling';
import type { WsCoreClient } from './client';
import type { DocumentSync } from './documentSync';
import { DEFAULT_SETTINGS, type Settings } from './settings';

/** The part of `WsCoreClient` completions use (a fake in tests). */
export type InlineClient = Pick<WsCoreClient, 'request' | 'notify' | 'state'>;

/** The part of `DocumentSync` that maps an editor to its synced URI. */
export type InlineSync = Pick<DocumentSync, 'uriForCell' | 'uriForFile'>;

export interface InlineProviderOptions {
  client: InlineClient;
  sync: InlineSync;
  /** The current LocalPilot settings (read on every fetch). */
  settings: () => Settings;
}

/**
 * Default for the completer's per-provider `timeout` (its own default is 5 s,
 * too short for a cold model load); a value set in the Inline Completer
 * settings wins.
 */
export const DEFAULT_TIMEOUT_MS = 20000;

interface CompletionResult {
  items?: Array<{ text: string }>;
}

/** A cell's or file's text model (`ISharedCell` / `ISharedFile`). */
interface SharedText {
  getSource(): string;
  readonly changed: ISignal<unknown, unknown>;
}

/** The document `context.widget` is completing in. */
interface Target {
  uri: string;
  text: SharedText;
}

/** How long a partly taken suggestion may sit without progress before its outcome is reported. */
export const OUTCOME_IDLE_MS = 2000;

/** The shown suggestion, watched through its document's changes until its outcome is known. */
interface Shown {
  requestId: string;
  uri: string;
  /** The document text before and after the cursor when it was requested. */
  before: string;
  after: string;
  suggestion: string;
  /** The longest prefix of `suggestion` now between `before` and `after`. */
  gained: string;
  /** What was there when shown (progress means gaining more). */
  baseline: number;
  /** Some gain arrived as a chunk: one edit inserting ≥ 2 characters (with a letter or digit), e.g. the completer's accept. */
  chunked: boolean;
  /** Taken over from a suggestion typed into (a typed-prefix hit): the run already progressed. */
  carried: boolean;
  timer?: ReturnType<typeof setTimeout>;
  off: () => void;
}

/**
 * The part of `middle` that is a prefix of `suggestion`, allowing trailing
 * auto-closed brackets/quotes the suggestion still has later (typing `foo(`
 * gives `foo()` while the suggestion is `foo(1)`); undefined once it diverged.
 * (Same rule as the VS Code client.)
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

/** The text one change inserted (a shared model's `sourceChange` delta with a single insert), else "". */
function insertedText(change: unknown): string {
  const delta = (change as { sourceChange?: unknown } | null)?.sourceChange;
  if (!Array.isArray(delta)) return '';
  const inserts = delta.filter((op) => typeof (op as { insert?: unknown })?.insert === 'string');
  return inserts.length === 1 ? (inserts[0] as { insert: string }).insert : '';
}

const EMPTY: IInlineCompletionList = { items: [] };

/**
 * The editor `context.widget` completes in, with its synced URI: the active
 * code cell of a NotebookPanel, or a file editor's document. Undefined for
 * anything DocumentSync does not mirror (markdown/raw cells, consoles,
 * untracked files, no `rootDir` yet).
 */
function targetOf(widget: unknown, sync: InlineSync): Target | undefined {
  const w = widget as
    | {
        context?: object;
        content?: {
          activeCell?: { model: { id: string; sharedModel: SharedText } } | null;
          model?: { sharedModel?: SharedText };
        };
      }
    | undefined;
  const content = w?.content;
  if (!content) return undefined;
  if ('activeCell' in content) {
    const model = content.activeCell?.model;
    const uri = model ? sync.uriForCell(model) : undefined;
    return uri && model ? { uri, text: model.sharedModel } : undefined;
  }
  const text = content.model?.sharedModel;
  const uri = w?.context ? sync.uriForFile(w.context) : undefined;
  return uri && text ? { uri, text } : undefined;
}

/** `{line, character}` (UTF-16, as the core expects) of UTF-16 index `jsIdx` in `text`. */
function positionAt(text: string, jsIdx: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < jsIdx; i = text.indexOf('\n', i + 1)) {
    line += 1;
    lineStart = i + 1;
  }
  return { line, character: jsIdx - lineStart };
}

/** `InlineCompletionTriggerKind.Automatic` (the completer module is imported for types only). */
const AUTOMATIC = 1;

interface Attachment {
  options: InlineProviderOptions;
}

/**
 * LocalPilot ghost-text completions for JupyterLab's inline completer
 * (`@jupyterlab/completer` 4.5).
 *
 * The manager cannot unregister a provider, so one instance is registered
 * once and `attach`ed to each plugin activation's client and document sync;
 * detached, it answers nothing.
 *
 * - Debounce: the completer's per-provider `debouncerDelay` setting, defaulted
 *   (via `schema.default`) to `completionDebounceMs`; a keystroke within it
 *   never reaches `fetch`.
 * - Cancellation: the completer passes no AbortSignal. Each `fetch`
 *   supersedes the previous one (the completer drops stale results), so an
 *   in-flight request is aborted with `completion/cancel`; so is one that
 *   outlives the completer's own deadline (`debouncerDelay + timeout` for a
 *   typing trigger, `timeout` for an explicit invoke).
 * - Outcomes (`completion/outcome`): the completer has no accept hook and no
 *   partial accept (4.5 offers only the full `accept()`, which inserts the
 *   rest of the item in one edit). The shown suggestion (the first item) is
 *   watched through its cell's / file's `sharedModel.changed`, as the VS Code
 *   client does: a "chunk" is one edit inserting ≥ 2 characters (with a
 *   letter or digit) that extends the suggestion — the completer's accept, or
 *   (a known bias) a tab-completer accept or paste that matches the ghost
 *   text. Once the text between the suggestion's surroundings is the whole
 *   suggestion (trailing whitespace ignored), stops matching, or
 *   `OUTCOME_IDLE_MS` pass without progress, it is reported once:
 *   - whole, with a chunk → `accepted` (with `acceptedText`);
 *   - whole, typed key by key → `typedThrough`;
 *   - part of it with a chunk → `partial` with `acceptedText`;
 *   - otherwise (untouched and superseded by the next fetch, or only part of
 *     it typed by hand) → `rejected`.
 *   Typing into the ghost text keeps it watched; when the next fetch shows
 *   the rest of it (the core's typed-prefix cache hit, whose request id the
 *   core resolves to the original suggestion) the watch moves to the new id
 *   unreported, keeping that the run progressed and whether a chunk was
 *   taken (and its idle wait), so a run with a chunk that then diverges or
 *   stalls is still `partial`; `acceptedText` is then what was taken since
 *   that id, and the core prepends what was typed before it.
 */
export class LocalPilotInlineProvider implements IInlineCompletionProvider {
  readonly identifier = 'localpilot';
  readonly name = 'LocalPilot';

  private seq = 0;
  private timeoutMs = DEFAULT_TIMEOUT_MS;
  private debouncerDelay?: number;
  private attached?: Attachment;
  private inflight?: { cancel: (notify: boolean) => void };
  private shown?: Shown;

  /**
   * Read by the Inline Completer settings when JupyterLab has restored:
   * enabled by default, debounced by `completionDebounceMs` and timed out
   * after `DEFAULT_TIMEOUT_MS` unless the user sets this provider's values there.
   */
  get schema(): ISettingRegistry.IProperty {
    return {
      type: 'object',
      default: { enabled: true, debouncerDelay: this.settings().completionDebounceMs, timeout: DEFAULT_TIMEOUT_MS }
    };
  }

  /** The completer's effective settings for this provider (`enabled`, `debouncerDelay`, `timeout`, …). */
  configure(settings: { [property: string]: unknown }): void {
    const { timeout, debouncerDelay } = settings ?? {};
    this.timeoutMs = typeof timeout === 'number' && timeout >= 0 ? timeout : DEFAULT_TIMEOUT_MS;
    this.debouncerDelay = typeof debouncerDelay === 'number' && debouncerDelay >= 0 ? debouncerDelay : undefined;
  }

  /** Serves completions through `options` until the returned disposable is disposed (or the next `attach`). */
  attach(options: InlineProviderOptions): IDisposable {
    this.detach();
    const attachment: Attachment = { options };
    this.attached = attachment;
    let disposed = false;
    return {
      get isDisposed() {
        return disposed;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.attached === attachment) this.detach();
      }
    };
  }

  async fetch(request: CompletionHandler.IRequest, context: IInlineCompletionContext): Promise<IInlineCompletionList> {
    const attachment = this.attached;
    if (!attachment) return EMPTY;
    const { client, sync, settings } = attachment.options;
    const target = settings().completionsEnabled ? targetOf(context.widget, sync) : undefined;
    // `request.offset` counts code points; the core wants UTF-16.
    const jsIdx = Text.charIndexToJsIndex(request.offset, request.text);
    const prefix = request.text.slice(0, jsIdx);
    const suffix = request.text.slice(jsIdx);
    this.supersede(target?.uri);
    if (!target || client.state !== 'ready') return EMPTY;
    // The active cell can change within the debounce window: the request must be about this text.
    if (target.text.getSource() !== request.text) return EMPTY;

    const requestId = String(++this.seq);
    const abort = new AbortController();
    let sent = false;
    const inflight = {
      cancel: (notify: boolean) => {
        if (abort.signal.aborted) return;
        abort.abort();
        if (notify && sent) client.notify('completion/cancel', { requestId });
      }
    };
    this.inflight = inflight;
    // Past this the completer has discarded our answer (its timer starts with
    // the debounce for a typing trigger).
    const delay = context.triggerKind === AUTOMATIC ? (this.debouncerDelay ?? settings().completionDebounceMs) : 0;
    const timer = setTimeout(() => inflight.cancel(true), delay + this.timeoutMs);
    let result: CompletionResult | undefined;
    try {
      // With `debouncerDelay: 0` the completer calls us from inside the edit's
      // change emission, possibly before DocumentSync's listener: yield so its
      // didChange goes out before our request.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (abort.signal.aborted || this.attached !== attachment) return EMPTY;
      sent = true;
      result = await client.request<CompletionResult>(
        'completion/request',
        { uri: target.uri, position: positionAt(request.text, jsIdx), requestId },
        abort.signal
      );
    } catch {
      return EMPTY; // cancelled, superseded, or the core is not running
    } finally {
      clearTimeout(timer);
      if (this.inflight === inflight) this.inflight = undefined;
    }
    if (abort.signal.aborted || this.attached !== attachment) return EMPTY;

    // The core's range is always empty at the cursor (engine.rs), which is
    // where the completer inserts; a multi-line completion stays one item.
    const items: IInlineCompletionItem[] = (result?.items ?? [])
      .filter((item) => typeof item?.text === 'string' && item.text.length > 0)
      .map((item) => ({ insertText: item.text }));
    if (items.length === 0) return EMPTY;
    this.show(requestId, target, prefix, suffix, items[0].insertText);
    return { items };
  }

  private settings(): Settings {
    return this.attached?.options.settings() ?? DEFAULT_SETTINGS;
  }

  /** Cancels quietly and forgets the shown suggestion (the client goes away with the activation). */
  private detach(): void {
    this.inflight?.cancel(false);
    this.inflight = undefined;
    if (this.shown) this.unwatch(this.shown);
    this.attached = undefined;
  }

  /**
   * Watches `target` for what happens to `suggestion` (requested between
   * `before` and `after`). A suggestion still being typed through whose rest
   * this one is hands its watch over unreported; any other is settled first.
   */
  private show(requestId: string, target: Target, before: string, after: string, suggestion: string): void {
    const prev = this.shown;
    let chunked = false;
    let carried = false;
    if (prev) {
      const handOff =
        prev.uri === target.uri &&
        prev.gained.length > prev.baseline &&
        prev.before + prev.gained === before &&
        prev.suggestion === prev.gained + suggestion;
      if (handOff) {
        chunked = prev.chunked;
        carried = true;
        this.unwatch(prev);
      } else {
        this.finish(prev);
      }
    }
    const changed = (_: unknown, change: unknown) => {
      if (this.shown === shown) this.update(shown, target.text.getSource(), insertedText(change));
    };
    const shown: Shown = {
      requestId,
      uri: target.uri,
      before,
      after,
      suggestion,
      gained: '',
      baseline: 0,
      chunked,
      carried,
      off: () => target.text.changed.disconnect(changed)
    };
    // The user may have typed on while the request ran.
    const now = this.matched(shown, target.text.getSource());
    if (now !== undefined) {
      shown.gained = now;
      shown.baseline = now.length;
    }
    target.text.changed.connect(changed);
    this.shown = shown;
    // A run with a chunk taken settles as partial if it stalls here.
    if (chunked) this.armIdle(shown);
  }

  /** The part of the suggestion now between its surroundings in `text`; undefined once it diverged. */
  private matched(t: Shown, text: string): string | undefined {
    const fits = text.length >= t.before.length + t.after.length && text.startsWith(t.before) && text.endsWith(t.after);
    return fits ? matchedPrefix(text.slice(t.before.length, text.length - t.after.length), t.suggestion) : undefined;
  }

  /** A change to the shown suggestion's document (`inserted`: what the edit inserted, if one insert). */
  private update(t: Shown, text: string, inserted: string): void {
    const gained = this.matched(t, text);
    if (gained === undefined) return this.finish(t);
    if (gained.length >= t.gained.length + 2 && inserted.length >= 2 && /\w/.test(inserted)) t.chunked = true;
    t.gained = gained;
    if (gained.length <= t.baseline) return;
    // Nothing more to take (trailing whitespace is not required: Enter auto-indents differently).
    if (gained.trimEnd() === t.suggestion.trimEnd()) return this.finish(t);
    this.armIdle(t);
  }

  /** (Re)starts `t`'s `OUTCOME_IDLE_MS` wait for progress. */
  private armIdle(t: Shown): void {
    clearTimeout(t.timer);
    t.timer = setTimeout(() => this.shown === t && this.finish(t), OUTCOME_IDLE_MS);
  }

  /** Stops watching `t` without reporting it. */
  private unwatch(t: Shown): void {
    clearTimeout(t.timer);
    t.off();
    if (this.shown === t) this.shown = undefined;
  }

  /** Stops watching `t` and reports its outcome (once). */
  private finish(t: Shown): void {
    this.unwatch(t);
    const client = this.attached?.options.client;
    if (!client) return;
    const { requestId, gained, suggestion } = t;
    // Under a typed-prefix id, `acceptedText` is what was taken since it (the
    // core puts the text typed before that hit back in front).
    const progressed = t.carried || gained.length > t.baseline;
    const whole = gained.trimEnd() === suggestion.trimEnd();
    let params: Record<string, string>;
    if (progressed && whole && t.chunked) params = { requestId, outcome: 'accepted', acceptedText: suggestion };
    else if (progressed && whole) params = { requestId, outcome: 'typedThrough' };
    else if (progressed && t.chunked) params = { requestId, outcome: 'partial', acceptedText: gained };
    else params = { requestId, outcome: 'rejected' };
    client.notify('completion/outcome', params);
  }

  /**
   * A new fetch for `uri`: the completer has dropped the previous request, so
   * the in-flight one is cancelled. The shown suggestion is settled after
   * the current change emission has reached our listener (the completer's
   * own listener can call `fetch` first, with `debouncerDelay: 0`): rejected
   * if it is untouched or this fetch is for another document; one being
   * typed through stays watched (rejecting it would evict the core's cache
   * entry the typed-prefix lookup serves from). Only the suggestion shown now
   * is settled: one shown meanwhile belongs to a later fetch (and one already
   * settled by it must not be reported twice).
   */
  private supersede(uri: string | undefined): void {
    this.inflight?.cancel(true);
    this.inflight = undefined;
    const t = this.shown;
    if (!t) return;
    setTimeout(() => {
      if (this.shown === t && (t.uri !== uri || t.gained.length <= t.baseline)) this.finish(t);
    }, 0);
  }
}
