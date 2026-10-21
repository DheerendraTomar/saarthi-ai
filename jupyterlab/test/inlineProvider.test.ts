// Types only: @jupyterlab/completer ships ES modules with a large import graph.
import type { CompletionHandler, IInlineCompletionContext, InlineCompletionTriggerKind } from '@jupyterlab/completer';
import { Text } from '@jupyterlab/coreutils';
import { Signal } from '@lumino/signaling';
import type { Widget } from '@lumino/widgets';
import { DEFAULT_TIMEOUT_MS, LocalPilotInlineProvider, type InlineClient, type InlineSync } from '../src/inlineProvider';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

// Stand-ins for the JupyterLab 4.5 objects the provider reads from
// `context.widget`: a NotebookPanel (content.activeCell.model) and a file
// editor's IDocumentWidget (context + content.model.sharedModel).

class FakeShared {
  readonly changed = new Signal<this, { sourceChange?: unknown }>(this);
  constructor(private source: string) {}
  getSource(): string {
    return this.source;
  }
  /** Replaces the text, emitting a Yjs-style delta of the change (common prefix/suffix kept), like the shared models. */
  setSource(text: string): void {
    const old = this.source;
    let start = 0;
    while (start < old.length && start < text.length && old[start] === text[start]) start++;
    let end = 0;
    while (end < old.length - start && end < text.length - start && old[old.length - 1 - end] === text[text.length - 1 - end]) end++;
    const delta: Array<Record<string, unknown>> = [];
    if (start) delta.push({ retain: start });
    if (old.length - start - end) delta.push({ delete: old.length - start - end });
    if (text.length - start - end) delta.push({ insert: text.slice(start, text.length - end) });
    this.source = text;
    this.changed.emit({ sourceChange: delta });
  }
}

function notebookWidget(cellId: string, source: string) {
  const model = { id: cellId, sharedModel: new FakeShared(source) };
  return { model, widget: { context: { localPath: 'nb/a.ipynb' }, content: { activeCell: { model } } } };
}

function fileWidget(source: string) {
  const sharedModel = new FakeShared(source);
  const context = { localPath: 'src/m.py' };
  return { sharedModel, context, widget: { context, content: { model: { sharedModel } } } };
}

const CELL_URI = 'file:///w/nb/a.ipynb.cell0.py';
const FILE_URI = 'file:///w/src/m.py';

class FakeSync implements InlineSync {
  cells = new Map<string, string>([['c1', CELL_URI]]);
  files = new Map<object, string>();
  uriForCell(cell: { id: string }): string | undefined {
    return this.cells.get(cell.id);
  }
  uriForFile(context: object): string | undefined {
    return this.files.get(context);
  }
}

interface Pending {
  method: string;
  params: { uri: string; position: { line: number; character: number }; requestId: string };
  signal?: AbortSignal;
  resolve(v: unknown): void;
  reject(e: unknown): void;
}

class FakeClient implements InlineClient {
  state: InlineClient['state'] = 'ready';
  readonly requests: Pending[] = [];
  readonly notes: Array<{ method: string; params: unknown }> = [];
  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const p = { method, params, signal, resolve, reject } as Pending;
      this.requests.push(p);
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  }
  notify(method: string, params?: unknown): void {
    this.notes.push({ method, params });
  }
}

/** A request as the completer handler composes it: `offset` in code points. */
function req(text: string, jsIdx = text.length): CompletionHandler.IRequest {
  return { text, offset: Text.jsIndexToCharIndex(jsIdx, text), mimeType: 'text/x-python' };
}

/** Typing (`Automatic`, 1) unless `invoke` (`Invoke`, 0: Alt+\\). */
function ctx(widget: object, invoke = false): IInlineCompletionContext {
  return { widget: widget as unknown as Widget, triggerKind: (invoke ? 0 : 1) as InlineCompletionTriggerKind };
}

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

let client: FakeClient;
let sync: FakeSync;
let settings: Settings;
let provider: LocalPilotInlineProvider;
let attachment: { dispose(): void };

beforeEach(() => {
  client = new FakeClient();
  sync = new FakeSync();
  settings = { ...DEFAULT_SETTINGS };
  provider = new LocalPilotInlineProvider();
  attachment = provider.attach({ client, sync, settings: () => settings });
});

afterEach(() => {
  attachment.dispose();
  jest.useRealTimers();
});

/** Lets the provider's awaits settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('LocalPilotInlineProvider', () => {
  it('identifies itself and defaults the completer debounce and timeout', () => {
    expect(provider.identifier).toBe('localpilot');
    expect(provider.name).toBe('LocalPilot');
    settings = { ...settings, completionDebounceMs: 321 };
    expect(DEFAULT_TIMEOUT_MS).toBe(20000);
    expect(provider.schema.default).toEqual({ enabled: true, debouncerDelay: 321, timeout: 20000 });
  });

  it('fetch_sends_request_for_cell_uri_with_utf16_position', async () => {
    const text = 'x = 1\ns = "😀😀" + y';
    const { widget } = notebookWidget('c1', text);
    // Code points and UTF-16 differ on the second line: 12 vs 14.
    expect(req(text).offset - 6).toBe(12);
    const result = provider.fetch(req(text), ctx(widget));
    await flush();
    expect(client.requests).toHaveLength(1);
    const [r] = client.requests;
    expect(r.method).toBe('completion/request');
    expect(r.params).toEqual({ uri: CELL_URI, position: { line: 1, character: 14 }, requestId: '1' });
    expect(r.signal).toBeInstanceOf(AbortSignal);
    r.resolve({ items: [{ text: 'z\nprint(s)', range: RANGE }] });
    // A multi-line completion is one item.
    expect(await result).toEqual({ items: [{ insertText: 'z\nprint(s)' }] });
  });

  it('uses the cursor position, not the end of the text', async () => {
    const text = 'a😀b\ncd';
    const { widget } = notebookWidget('c1', text);
    void provider.fetch(req(text, 3), ctx(widget)); // after the emoji
    await flush();
    expect(client.requests[0].params.position).toEqual({ line: 0, character: 3 });
  });

  it('sends a file editor request with its synced file uri', async () => {
    const { widget, context } = fileWidget('import o');
    sync.files.set(context, FILE_URI);
    void provider.fetch(req('import o'), ctx(widget));
    await flush();
    expect(client.requests[0].params).toEqual({
      uri: FILE_URI,
      position: { line: 0, character: 8 },
      requestId: '1'
    });
  });

  it('abort_sends_cancel', async () => {
    const { widget, model } = notebookWidget('c1', 'x = ');
    const first = provider.fetch(req('x = '), ctx(widget));
    await flush();
    // The completer moved on (a newer keystroke): the in-flight request is cancelled.
    model.sharedModel.setSource('x = 1');
    const second = provider.fetch(req('x = 1'), ctx(widget));
    await flush();
    expect(client.requests[0].signal?.aborted).toBe(true);
    expect(client.notes).toEqual([{ method: 'completion/cancel', params: { requestId: '1' } }]);
    expect(await first).toEqual({ items: [] });
    expect(client.requests[1].params.requestId).toBe('2');
    client.requests[1].resolve({ items: [] });
    await second;
  });

  /** With fake timers: fetch, let the deferred send go out, then expect the cancel exactly `ms` after fetch. */
  async function expectCancelAfter(ms: number, invoke = false) {
    const { widget } = notebookWidget('c1', 'x = ');
    const result = provider.fetch(req('x = '), ctx(widget, invoke));
    await jest.advanceTimersByTimeAsync(0);
    expect(client.requests).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(ms - 1);
    expect(client.notes).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(client.notes).toEqual([{ method: 'completion/cancel', params: { requestId: '1' } }]);
    expect(await result).toEqual({ items: [] });
  }

  it('cancels a request the completer has timed out (debouncerDelay + timeout)', async () => {
    jest.useFakeTimers();
    provider.configure({ enabled: true, debouncerDelay: 200, timeout: 1000, autoFillInMiddle: false });
    await expectCancelAfter(1200);
  });

  it('an explicit invoke is not debounced, so only the timeout counts', async () => {
    jest.useFakeTimers();
    provider.configure({ enabled: true, debouncerDelay: 200, timeout: 1000, autoFillInMiddle: false });
    await expectCancelAfter(1000, true);
  });

  it('defaults to completionDebounceMs + 20 s before configure', async () => {
    jest.useFakeTimers();
    await expectCancelAfter(settings.completionDebounceMs + DEFAULT_TIMEOUT_MS);
  });

  it('sends the request after the current change emission (didChange goes first)', async () => {
    const { widget } = notebookWidget('c1', 'x = ');
    void provider.fetch(req('x = '), ctx(widget));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.requests).toEqual([]);
    await flush();
    expect(client.requests).toHaveLength(1);
  });

  it('a fetch superseded before it was sent sends nothing', async () => {
    const { widget, model } = notebookWidget('c1', 'x = ');
    const first = provider.fetch(req('x = '), ctx(widget));
    model.sharedModel.setSource('x = 1');
    void provider.fetch(req('x = 1'), ctx(widget));
    expect(await first).toEqual({ items: [] });
    await flush();
    expect(client.notes).toEqual([]);
    expect(client.requests.map((r) => r.params.requestId)).toEqual(['2']);
  });

  it('skips a request whose text is not the target cell (active cell changed while debouncing)', async () => {
    const { widget } = notebookWidget('c1', 'other cell');
    expect(await provider.fetch(req('x = '), ctx(widget))).toEqual({ items: [] });
    expect(client.requests).toEqual([]);
  });

  it('empty_items_yield_no_suggestion', async () => {
    const { widget, model } = notebookWidget('c1', 'x = ');
    const result = provider.fetch(req('x = '), ctx(widget));
    await flush();
    client.requests[0].resolve({ items: [] });
    expect(await result).toEqual({ items: [] });
    // Nothing was shown, so nothing is rejected by the next fetch.
    model.sharedModel.setSource('x = 2');
    void provider.fetch(req('x = 2'), ctx(widget));
    await flush();
    expect(client.notes).toEqual([]);
  });

  it('a failed request yields no suggestion', async () => {
    const { widget } = notebookWidget('c1', 'x = ');
    const result = provider.fetch(req('x = '), ctx(widget));
    await flush();
    client.requests[0].reject(new Error('core gone'));
    expect(await result).toEqual({ items: [] });
  });

  it('disabled_returns_empty_without_request', async () => {
    settings = { ...settings, completionsEnabled: false };
    const { widget } = notebookWidget('c1', 'x = ');
    expect(await provider.fetch(req('x = '), ctx(widget))).toEqual({ items: [] });
    expect(client.requests).toEqual([]);
    expect(client.notes).toEqual([]);
  });

  it('skips unsynced editors and a client that is not ready', async () => {
    const markdown = notebookWidget('md', '# title'); // uriForCell → undefined
    const untracked = fileWidget('x'); // no uriForFile
    const noCell = { context: {}, content: { activeCell: null } };
    const consolePanel = { content: {} };
    for (const w of [markdown.widget, untracked.widget, noCell, consolePanel]) {
      expect(await provider.fetch(req('x'), ctx(w))).toEqual({ items: [] });
    }
    client.state = 'reconnecting';
    expect(await provider.fetch(req('x'), ctx(notebookWidget('c1', 'x').widget))).toEqual({ items: [] });
    expect(client.requests).toEqual([]);
    expect(client.notes).toEqual([]);
  });

  async function show(text: string, insert: string, widget: object) {
    const result = provider.fetch(req(text), ctx(widget));
    await flush();
    client.requests[client.requests.length - 1].resolve({ items: [{ text: insert, range: RANGE }] });
    expect(await result).toEqual({ items: [{ insertText: insert }] });
  }

  const outcome = (requestId: string, kind: string, acceptedText?: string) => ({
    method: 'completion/outcome',
    params: acceptedText === undefined ? { requestId, outcome: kind } : { requestId, outcome: kind, acceptedText }
  });

  it('provider_reports_outcome_accepted_and_rejected', async () => {
    const { widget, model } = notebookWidget('c1', 'x = ');
    await show('x = ', '42\ny = x', widget);
    model.sharedModel.setSource('x = 4'); // one typed character: not an accept
    expect(client.notes).toEqual([]);
    model.sharedModel.setSource('x = 42\ny = x'); // InlineCompleter.accept(): the rest in one edit
    expect(client.notes).toEqual([outcome('1', 'accepted', '42\ny = x')]);
    // The follow-up fetch does not also report it.
    void provider.fetch(req('x = 42\ny = x'), ctx(widget));
    await flush();
    expect(client.notes).toHaveLength(1);

    // A suggestion the user types past is rejected, once (the pending follow-up fetch was cancelled).
    await show('x = 42\ny = x', '\nz = 1', widget);
    const outcomes = () => client.notes.filter((n) => n.method === 'completion/outcome');
    model.sharedModel.setSource('x = 42\ny = x7');
    expect(outcomes()).toEqual([outcome('1', 'accepted', '42\ny = x'), outcome('3', 'rejected')]);
    model.sharedModel.setSource('x = 42\ny = x\nz = 1');
    expect(outcomes()).toHaveLength(2);
  });

  it('reports accepted when the completer re-enters fetch before our change listener runs', async () => {
    const { widget, model } = notebookWidget('c1', 'x = ');
    // The completer's own change listener is connected first and fetches at once.
    model.sharedModel.changed.connect(() => void provider.fetch(req(model.sharedModel.getSource()), ctx(widget)));
    await show('x = ', '42', widget);
    model.sharedModel.setSource('x = 42');
    await flush();
    expect(client.notes).toEqual([outcome('1', 'accepted', '42')]);
  });

  it('an untouched suggestion the next fetch supersedes is rejected', async () => {
    const { widget } = notebookWidget('c1', 'x = ');
    await show('x = ', '42', widget);
    void provider.fetch(req('x = ', 2), ctx(widget, true)); // cursor moved, explicit invoke
    await flush();
    expect(client.notes).toEqual([outcome('1', 'rejected')]);
  });

  it('typing the whole suggestion by hand is typedThrough', async () => {
    const { widget, model } = notebookWidget('c1', 'x = ');
    await show('x = ', '42', widget);
    model.sharedModel.setSource('x = 4');
    model.sharedModel.setSource('x = 42');
    expect(client.notes).toEqual([outcome('1', 'typedThrough')]);
  });

  it('a chunk then divergence is partial with the taken text', async () => {
    const { widget, model } = notebookWidget('c1', 'x = ');
    await show('x = ', 'foo(bar)', widget);
    model.sharedModel.setSource('x = foo'); // e.g. a tab-completer accept matching the ghost text
    expect(client.notes).toEqual([]);
    model.sharedModel.setSource('x = fooz');
    expect(client.notes).toEqual([outcome('1', 'partial', 'foo')]);
  });

  it('a partly taken suggestion is reported after 2 s without progress', async () => {
    const { widget, model } = notebookWidget('c1', 'x = ');
    await show('x = ', 'foo(bar)', widget);
    jest.useFakeTimers();
    model.sharedModel.setSource('x = foo');
    jest.advanceTimersByTime(1999);
    expect(client.notes).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(client.notes).toEqual([outcome('1', 'partial', 'foo')]);
  });

  it('typing through a shown suggestion hands it off to the typed-prefix hit', async () => {
    const { widget, model } = notebookWidget('c1', 'x = ');
    await show('x = ', '42\ny = x', widget);
    // The user types the first character of the ghost text; the completer
    // keeps it and fetches again.
    model.sharedModel.setSource('x = 4');
    const next = provider.fetch(req('x = 4'), ctx(widget));
    await flush();
    expect(client.notes).toEqual([]);
    expect(client.requests[1].params.position).toEqual({ line: 0, character: 5 });
    // The core serves the rest from the same cache entry (and resolves this id
    // to the original record): the new suggestion takes over unreported.
    client.requests[1].resolve({ items: [{ text: '2\ny = x', range: RANGE }] });
    expect(await next).toEqual({ items: [{ insertText: '2\ny = x' }] });
    expect(client.notes).toEqual([]);
    model.sharedModel.setSource('x = 42\ny = x');
    expect(client.notes).toEqual([outcome('2', 'accepted', '2\ny = x')]);
  });

  it('a different new suggestion settles the partly typed one first', async () => {
    const { widget, model } = notebookWidget('c1', 'x = ');
    await show('x = ', '42', widget);
    model.sharedModel.setSource('x = 4');
    const next = provider.fetch(req('x = 4'), ctx(widget));
    await flush();
    client.requests[1].resolve({ items: [{ text: '00', range: RANGE }] }); // not the rest of "42"
    await next;
    expect(client.notes).toEqual([outcome('1', 'rejected')]);
  });

  it('typing through then diverging rejects the suggestion', async () => {
    const { widget, model } = notebookWidget('c1', 'x = ');
    await show('x = ', '42', widget);
    model.sharedModel.setSource('x = 4');
    void provider.fetch(req('x = 4'), ctx(widget));
    await flush();
    client.requests[1].resolve({ items: [] }); // nothing new: the first one is still watched
    await flush();
    expect(client.notes).toEqual([]);
    model.sharedModel.setSource('x = 47');
    expect(client.notes).toEqual([outcome('1', 'rejected')]);
  });

  it('detach cancels quietly and stops fetching', async () => {
    const { widget } = notebookWidget('c1', 'x = ');
    const result = provider.fetch(req('x = '), ctx(widget));
    await flush();
    attachment.dispose();
    expect(client.requests[0].signal?.aborted).toBe(true);
    expect(await result).toEqual({ items: [] });
    expect(await provider.fetch(req('x = '), ctx(widget))).toEqual({ items: [] });
    expect(client.requests).toHaveLength(1);
    expect(client.notes).toEqual([]);
  });

  it('re-attaching serves the new activation', async () => {
    const { widget } = notebookWidget('c1', 'x = ');
    attachment.dispose();
    const client2 = new FakeClient();
    attachment = provider.attach({ client: client2, sync, settings: () => settings });
    void provider.fetch(req('x = '), ctx(widget));
    await flush();
    expect(client.requests).toEqual([]);
    expect(client2.requests).toHaveLength(1);
  });
});
