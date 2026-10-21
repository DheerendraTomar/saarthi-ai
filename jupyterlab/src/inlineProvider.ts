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
import type { Settings } from './settings';

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

/** The completer's own timeout for a provider unless the user changes it (`InlineCompleter` settings). */
const DEFAULT_TIMEOUT_MS = 5000;

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

/**
 * LocalPilot ghost-text completions for JupyterLab's inline completer
 * (`@jupyterlab/completer` 4.5).
 *
 * - Debounce: the completer's per-provider `debouncerDelay` setting, defaulted
 *   (via `schema.default`) to `completionDebounceMs`; a keystroke within it
 *   never reaches `fetch`.
 * - Cancellation: the completer passes no AbortSignal. Each `fetch`
 *   supersedes the previous one (the completer drops stale results), so an
 *   in-flight request is aborted with `completion/cancel`; so is one that
 *   outlives the completer's `timeout`.
 * - Accept/reject: the completer has no hook. A shown item counts as accepted
 *   once the document's text starts with the text before the cursor plus the
 *   item (what `InlineCompleter.accept()` produces); otherwise the next `fetch`
 *   reports it `completion/rejected`.
 */
export class LocalPilotInlineProvider implements IInlineCompletionProvider, IDisposable {
  readonly identifier = 'localpilot';
  readonly name = 'LocalPilot';

  private seq = 0;
  private timeoutMs = DEFAULT_TIMEOUT_MS;
  private inflight?: { cancel: (notify: boolean) => void };
  private shown?: Shown;
  private disposed = false;

  constructor(private readonly options: InlineProviderOptions) {}

  /**
   * Read by the Inline Completer settings when JupyterLab has restored:
   * enabled by default, debounced by `completionDebounceMs` unless the user
   * sets this provider's "Debouncer delay" there.
   */
  get schema(): ISettingRegistry.IProperty {
    return {
      type: 'object',
      default: { enabled: true, debouncerDelay: this.options.settings().completionDebounceMs }
    };
  }

  /** The completer's effective settings for this provider (`enabled`, `debouncerDelay`, `timeout`, …). */
  configure(settings: { [property: string]: unknown }): void {
    const timeout = settings?.timeout;
    this.timeoutMs = typeof timeout === 'number' && timeout >= 0 ? timeout : DEFAULT_TIMEOUT_MS;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inflight?.cancel(false);
    this.inflight = undefined;
    this.shown?.off();
    this.shown = undefined;
  }

  async fetch(request: CompletionHandler.IRequest, context: IInlineCompletionContext): Promise<IInlineCompletionList> {
    if (this.disposed) return EMPTY;
    const { client, sync, settings } = this.options;
    const target = settings().completionsEnabled ? targetOf(context.widget, sync) : undefined;
    // `request.offset` counts code points; the core wants UTF-16.
    const jsIdx = Text.charIndexToJsIndex(request.offset, request.text);
    const prefix = request.text.slice(0, jsIdx);
    this.supersede(target?.uri, request.text);
    if (!target || client.state !== 'ready') return EMPTY;

    const requestId = String(++this.seq);
    const abort = new AbortController();
    const inflight = {
      cancel: (notify: boolean) => {
        if (abort.signal.aborted) return;
        abort.abort();
        if (notify) client.notify('completion/cancel', { requestId });
      }
    };
    this.inflight = inflight;
    // Past its timeout the completer has discarded our answer.
    const timer = setTimeout(() => inflight.cancel(true), this.timeoutMs);
    let result: CompletionResult | undefined;
    try {
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
    if (abort.signal.aborted || this.disposed) return EMPTY;

    // The core's range is always empty at the cursor (engine.rs), which is
    // where the completer inserts; a multi-line completion stays one item.
    const items: IInlineCompletionItem[] = (result?.items ?? [])
      .filter((item) => typeof item?.text === 'string' && item.text.length > 0)
      .map((item) => ({ insertText: item.text }));
    if (items.length === 0) return EMPTY;
    this.show(requestId, target, items.map((item) => prefix + item.insertText));
    return { items };
  }

  /** Watches the document for the shown items being accepted. */
  private show(requestId: string, target: Target, accepted: string[]): void {
    const changed = () => {
      if (this.shown === shown && this.isAccepted(target.text.getSource())) this.report('completion/accepted');
    };
    target.text.changed.connect(changed);
    const shown: Shown = { requestId, uri: target.uri, accepted, off: () => target.text.changed.disconnect(changed) };
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
    this.options.client.notify(method, { requestId: shown.requestId });
  }

  /**
   * A new fetch: the completer has dropped whatever came before. Cancels the
   * in-flight request and reports the shown suggestion: accepted if the
   * document (`uri`, now `text`) already holds it (the completer's change
   * listener can run before ours), rejected otherwise.
   */
  private supersede(uri: string | undefined, text: string): void {
    this.inflight?.cancel(true);
    this.inflight = undefined;
    if (!this.shown) return;
    const accepted = this.shown.uri === uri && this.isAccepted(text);
    this.report(accepted ? 'completion/accepted' : 'completion/rejected');
  }
}
