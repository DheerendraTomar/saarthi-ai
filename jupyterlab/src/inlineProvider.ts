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

interface Shown {
  requestId: string;
  uri: string;
  /** The document text before and after the cursor when it was shown. */
  prefix: string;
  suffix: string;
  /** The document text up to the cursor followed by each item's text: an accepted item starts the source. */
  accepted: string[];
  off: () => void;
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
 * - Accept/reject: the completer has no hook. A shown item counts as accepted
 *   once the document's text starts with the text before the cursor plus the
 *   item (what `InlineCompleter.accept()` produces). Typing through it (the
 *   ghost text stays) keeps it pending; any other next `fetch` reports it
 *   `completion/rejected`.
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
    this.supersede(target?.uri, prefix, suffix, request.text);
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
    this.show({ requestId, uri: target.uri, prefix, suffix, accepted: items.map((i) => prefix + i.insertText) }, target);
    return { items };
  }

  private settings(): Settings {
    return this.attached?.options.settings() ?? DEFAULT_SETTINGS;
  }

  /** Cancels quietly and forgets the shown suggestion (the client goes away with the activation). */
  private detach(): void {
    this.inflight?.cancel(false);
    this.inflight = undefined;
    this.shown?.off();
    this.shown = undefined;
    this.attached = undefined;
  }

  /**
   * Watches the document for the shown items being accepted. A suggestion
   * still pending (typed through) is handed off unreported: the core served
   * the new one from the same cache entry.
   */
  private show(info: Omit<Shown, 'off'>, target: Target): void {
    this.shown?.off();
    const changed = () => {
      if (this.shown === shown && this.isAccepted(target.text.getSource())) this.report('completion/accepted');
    };
    target.text.changed.connect(changed);
    const shown: Shown = { ...info, off: () => target.text.changed.disconnect(changed) };
    this.shown = shown;
  }

  private isAccepted(source: string): boolean {
    return this.shown?.accepted.some((text) => source.startsWith(text)) ?? false;
  }

  /** Reports the shown suggestion once, then stops watching it. */
  private report(method: 'completion/accepted' | 'completion/rejected'): void {
    const shown = this.shown;
    if (!shown) return;
    this.shown = undefined;
    shown.off();
    this.attached?.options.client.notify(method, { requestId: shown.requestId });
  }

  /**
   * A new fetch (`uri`, cursor between `prefix` and `suffix` of `text`): the
   * completer has dropped the previous request, so the in-flight one is
   * cancelled. The shown suggestion is
   * - accepted if the document already holds it (the completer's change
   *   listener can run before ours);
   * - still pending if the user typed into it (the completer keeps the ghost
   *   text; rejecting would evict the core's cache entry the typed-prefix
   *   lookup serves from);
   * - rejected otherwise.
   */
  private supersede(uri: string | undefined, prefix: string, suffix: string, text: string): void {
    this.inflight?.cancel(true);
    this.inflight = undefined;
    const shown = this.shown;
    if (!shown) return;
    if (shown.uri === uri) {
      if (this.isAccepted(text)) return this.report('completion/accepted');
      const typedThrough =
        suffix === shown.suffix &&
        prefix.length > shown.prefix.length &&
        prefix.startsWith(shown.prefix) &&
        shown.accepted.some((item) => item.startsWith(prefix));
      if (typedThrough) return;
    }
    this.report('completion/rejected');
  }
}
