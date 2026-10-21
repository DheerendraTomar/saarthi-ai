import { Signal } from '@lumino/signaling';
import { CONCAT_DEBOUNCE_MS, DocumentSync, type SyncClient } from '../src/documentSync';

// Minimal stand-ins for the JupyterLab 4.5 objects DocumentSync reads:
// NotebookPanel / IDocumentWidget<FileEditor> (context + disposed), the
// notebook model (cells list, metadata) and cell / text shared models.

type Change = { sourceChange?: unknown; metadataChange?: unknown };

class FakeShared {
  readonly changed = new Signal<this, Change>(this);
  constructor(private source: string) {}
  getSource(): string {
    return this.source;
  }
  setSource(text: string): void {
    this.source = text;
    this.changed.emit({ sourceChange: [{ insert: text }] });
  }
}

let nextId = 0;
class FakeCell {
  readonly id = `cell-${++nextId}`;
  readonly sharedModel: FakeShared;
  constructor(
    readonly type: 'code' | 'markdown' | 'raw',
    source: string
  ) {
    this.sharedModel = new FakeShared(source);
  }
}

class FakeCellList {
  readonly changed = new Signal<this, { type: string }>(this);
  constructor(private cells: FakeCell[]) {}
  get length(): number {
    return this.cells.length;
  }
  get(i: number): FakeCell {
    return this.cells[i];
  }
  insert(i: number, cell: FakeCell): void {
    this.cells.splice(i, 0, cell);
    this.changed.emit({ type: 'add' });
  }
  move(from: number, to: number): void {
    const [cell] = this.cells.splice(from, 1);
    this.cells.splice(to, 0, cell);
    this.changed.emit({ type: 'move' });
  }
  remove(i: number): void {
    this.cells.splice(i, 1);
    this.changed.emit({ type: 'remove' });
  }
}

class FakeNotebookModel {
  readonly metadataChanged = new Signal<this, { key: string }>(this);
  readonly cells: FakeCellList;
  constructor(
    cells: FakeCell[],
    private metadata: Record<string, unknown>
  ) {
    this.cells = new FakeCellList(cells);
  }
  getMetadata(key: string): unknown {
    return this.metadata[key];
  }
  setMetadata(key: string, value: unknown): void {
    this.metadata[key] = value;
    this.metadataChanged.emit({ key });
  }
}

class FakeContext<M> {
  readonly saveState = new Signal<this, string>(this);
  readonly pathChanged = new Signal<this, string>(this);
  readonly disposed = new Signal<this, void>(this);
  isDisposed = false;
  ready = Promise.resolve();
  constructor(
    public localPath: string,
    readonly model: M
  ) {}
  save(): void {
    this.saveState.emit('started');
    this.saveState.emit('completed');
  }
  rename(path: string): void {
    this.localPath = path;
    this.pathChanged.emit(path);
  }
  dispose(): void {
    this.isDisposed = true;
    this.disposed.emit();
  }
}

class FakeWidget<M> {
  readonly disposed = new Signal<this, void>(this);
  isDisposed = false;
  /** A file editor's `content.model` is its context's model. */
  readonly content: { model: M };
  constructor(readonly context: FakeContext<M>) {
    this.content = { model: context.model };
  }
}

class FakeTracker<W> {
  readonly widgetAdded = new Signal<this, W>(this);
  private readonly widgets: W[] = [];
  forEach(fn: (w: W) => void): void {
    this.widgets.forEach(fn);
  }
  add(w: W): void {
    this.widgets.push(w);
    this.widgetAdded.emit(w);
  }
}

class FakeClient implements SyncClient {
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  private readonly reconnectListeners = new Set<() => void>();
  notify(method: string, params?: unknown): void {
    this.sent.push({ method, params: params as Record<string, unknown> });
  }
  onReconnect(listener: () => void) {
    this.reconnectListeners.add(listener);
    return {
      isDisposed: false,
      dispose: () => {
        this.reconnectListeners.delete(listener);
      }
    };
  }
  reconnected(): void {
    this.reconnectListeners.forEach((l) => l());
  }
  /** `method uri` pairs, then forgets them. */
  take(): string[] {
    const out = this.sent.map((m) => `${m.method.replace('textDocument/', '')} ${m.params.uri}`);
    this.sent.length = 0;
    return out;
  }
  takeAll() {
    const out = this.sent.slice();
    this.sent.length = 0;
    return out;
  }
}

const ROOT = '/w';
const NB = 'file:///w/nb/a.ipynb';

/** Lets `context.ready` and the root-dir promise settle (promises are not faked). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function python(): Record<string, unknown> {
  return { language_info: { name: 'python' }, kernelspec: { name: 'python3', language: 'python' } };
}

async function setup(cells: FakeCell[], metadata: Record<string, unknown> = python()) {
  const client = new FakeClient();
  const notebooks = new FakeTracker<FakeWidget<FakeNotebookModel>>();
  const editors = new FakeTracker<FakeWidget<{ sharedModel: FakeShared }>>();
  const model = new FakeNotebookModel(cells, metadata);
  const context = new FakeContext('nb/a.ipynb', model);
  const sync = new DocumentSync(client, notebooks as never, editors as never, { rootDir: ROOT });
  notebooks.add(new FakeWidget(context));
  await settle();
  return { client, notebooks, editors, model, context, sync };
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('DocumentSync', () => {
  it('cells_map_to_virtual_uris_and_concat', async () => {
    const a = new FakeCell('code', 'x = 1');
    const md = new FakeCell('markdown', '# title');
    const b = new FakeCell('code', 'y = 2');
    const { client, sync } = await setup([a, md, b]);

    expect(client.takeAll()).toEqual([
      {
        method: 'textDocument/didOpen',
        params: { uri: `${NB}.cell0.py`, languageId: 'python', version: 1, text: 'x = 1' }
      },
      {
        method: 'textDocument/didOpen',
        params: { uri: `${NB}.cell2.py`, languageId: 'python', version: 1, text: 'y = 2' }
      },
      {
        method: 'textDocument/didOpen',
        params: { uri: `${NB}.cells.py`, languageId: 'python', version: 1, text: 'x = 1\n\ny = 2' }
      }
    ]);
    expect(sync.uriForCell(b)).toBe(`${NB}.cell2.py`);
    expect(sync.cellForUri(`${NB}.cell2.py`)?.cellId).toBe(b.id);
    expect(sync.cellForUri(`${NB}.cells.py`)).toBeUndefined();

    // A keystroke: full-text didChange of the cell at once, the concat doc debounced.
    b.sharedModel.setSource('y = 3');
    b.sharedModel.setSource('y = 34');
    expect(client.takeAll()).toEqual([
      {
        method: 'textDocument/didChange',
        params: { uri: `${NB}.cell2.py`, version: 2, contentChanges: [{ text: 'y = 3' }] }
      },
      {
        method: 'textDocument/didChange',
        params: { uri: `${NB}.cell2.py`, version: 3, contentChanges: [{ text: 'y = 34' }] }
      }
    ]);
    jest.advanceTimersByTime(CONCAT_DEBOUNCE_MS - 1);
    expect(client.sent).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(client.takeAll()).toEqual([
      {
        method: 'textDocument/didChange',
        params: { uri: `${NB}.cells.py`, version: 2, contentChanges: [{ text: 'x = 1\n\ny = 34' }] }
      }
    ]);

    // Output / metadata changes of a cell are not source changes.
    a.sharedModel.changed.emit({ metadataChange: {} });
    jest.advanceTimersByTime(CONCAT_DEBOUNCE_MS);
    expect(client.sent).toEqual([]);
  });

  it('markdown_cells_not_synced', async () => {
    const md = new FakeCell('markdown', '# a');
    const raw = new FakeCell('raw', 'raw');
    const { client, sync, model } = await setup([md, raw]);
    expect(client.take()).toEqual([]); // no code cells: no cell docs and no concat doc

    md.sharedModel.setSource('# b');
    jest.advanceTimersByTime(CONCAT_DEBOUNCE_MS);
    expect(client.sent).toEqual([]);
    expect(sync.uriForCell(md)).toBeUndefined();

    // Adding a markdown cell before a code cell shifts nothing it does not own.
    const code = new FakeCell('code', 'z');
    model.cells.insert(2, code);
    expect(client.take()).toEqual([`didOpen ${NB}.cell2.py`, `didOpen ${NB}.cells.py`]);
    model.cells.insert(0, new FakeCell('markdown', 'note'));
    expect(client.take()).toEqual([`didClose ${NB}.cell2.py`, `didOpen ${NB}.cell3.py`]);
  });

  it('unknown_kernel_language_uses_txt', async () => {
    const cell = new FakeCell('code', 'IDENTIFICATION DIVISION.');
    const { client, model } = await setup([cell], { language_info: { name: 'cobol' } });
    expect(client.takeAll()).toEqual([
      {
        method: 'textDocument/didOpen',
        params: { uri: `${NB}.cell0.txt`, languageId: 'cobol', version: 1, text: 'IDENTIFICATION DIVISION.' }
      },
      {
        method: 'textDocument/didOpen',
        params: { uri: `${NB}.cells.txt`, languageId: 'cobol', version: 1, text: 'IDENTIFICATION DIVISION.' }
      }
    ]);

    // The kernel's language arrives later: the docs move to the new extension.
    model.setMetadata('language_info', { name: 'python' });
    expect(client.take()).toEqual([
      `didClose ${NB}.cell0.txt`,
      `didOpen ${NB}.cell0.py`,
      `didClose ${NB}.cells.txt`,
      `didOpen ${NB}.cells.py`
    ]);

    // No language metadata at all (a fresh notebook before its kernel starts).
    const other = await setup([new FakeCell('code', 'x')], {});
    expect(other.client.takeAll()).toEqual([
      { method: 'textDocument/didOpen', params: { uri: `${NB}.cell0.txt`, languageId: 'plaintext', version: 1, text: 'x' } },
      { method: 'textDocument/didOpen', params: { uri: `${NB}.cells.txt`, languageId: 'plaintext', version: 1, text: 'x' } }
    ]);
  });

  it('cell_move_reindexes_docs', async () => {
    const a = new FakeCell('code', 'a');
    const b = new FakeCell('code', 'b');
    const c = new FakeCell('code', 'c');
    const { client, model, sync } = await setup([a, b, c]);
    client.take();

    model.cells.move(2, 0); // c a b
    const sent = client.takeAll();
    // Old indices are closed before new ones are opened (cell0 is closed and reused).
    expect(sent.map((m) => `${m.method.replace('textDocument/', '')} ${m.params.uri}`)).toEqual([
      `didClose ${NB}.cell0.py`,
      `didClose ${NB}.cell1.py`,
      `didClose ${NB}.cell2.py`,
      `didOpen ${NB}.cell0.py`,
      `didOpen ${NB}.cell1.py`,
      `didOpen ${NB}.cell2.py`
    ]);
    expect(sent.filter((m) => m.method === 'textDocument/didOpen').map((m) => m.params.text)).toEqual(['c', 'a', 'b']);
    expect(sync.cellForUri(`${NB}.cell0.py`)?.cellId).toBe(c.id);
    expect(sync.uriForCell(a)).toBe(`${NB}.cell1.py`);

    jest.advanceTimersByTime(CONCAT_DEBOUNCE_MS);
    expect(client.takeAll()).toEqual([
      {
        method: 'textDocument/didChange',
        params: { uri: `${NB}.cells.py`, version: 2, contentChanges: [{ text: 'c\n\na\n\nb' }] }
      }
    ]);

    // Deleting the first cell re-indexes the rest; edits then go to the new uri.
    model.cells.remove(0); // a b
    expect(client.take()).toEqual([
      `didClose ${NB}.cell0.py`,
      `didClose ${NB}.cell1.py`,
      `didClose ${NB}.cell2.py`,
      `didOpen ${NB}.cell0.py`,
      `didOpen ${NB}.cell1.py`
    ]);
    b.sharedModel.setSource('bb');
    expect(client.take()).toEqual([`didChange ${NB}.cell1.py`]);
    expect(sync.cellForUri(`${NB}.cell2.py`)).toBeUndefined();
  });

  it('close_notebook_closes_all_virtual_docs', async () => {
    const a = new FakeCell('code', 'a');
    const b = new FakeCell('code', 'b');
    const { client, context, sync } = await setup([a, new FakeCell('markdown', 'm'), b]);
    client.take();

    context.save();
    expect(client.take()).toEqual([`didSave ${NB}.cell0.py`, `didSave ${NB}.cell2.py`, `didSave ${NB}.cells.py`]);

    a.sharedModel.setSource('a2'); // leaves a concat update pending
    client.take();
    context.dispose();
    expect(client.take()).toEqual([`didClose ${NB}.cell0.py`, `didClose ${NB}.cell2.py`, `didClose ${NB}.cells.py`]);
    jest.advanceTimersByTime(CONCAT_DEBOUNCE_MS * 2);
    a.sharedModel.setSource('a3');
    expect(client.sent).toEqual([]);
    expect(sync.cellForUri(`${NB}.cell0.py`)).toBeUndefined();
    expect(sync.uriForCell(a)).toBeUndefined();
  });

  it('replay_resends_all_open_docs', async () => {
    const a = new FakeCell('code', 'a');
    const { client, editors, sync } = await setup([a]);
    const file = new FakeContext('src/my mod.py', { sharedModel: new FakeShared('import os') });
    editors.add(new FakeWidget(file));
    await settle();
    expect(client.takeAll()).toEqual([
      {
        method: 'textDocument/didOpen',
        params: { uri: `${NB}.cell0.py`, languageId: 'python', version: 1, text: 'a' }
      },
      {
        method: 'textDocument/didOpen',
        params: { uri: `${NB}.cells.py`, languageId: 'python', version: 1, text: 'a' }
      },
      {
        method: 'textDocument/didOpen',
        params: { uri: 'file:///w/src/my%20mod.py', languageId: 'python', version: 1, text: 'import os' }
      }
    ]);
    expect(sync.uriForFile(file)).toBe('file:///w/src/my%20mod.py');
    expect(sync.uriForFile({})).toBeUndefined();

    file.model.sharedModel.setSource('import sys');
    a.sharedModel.setSource('a2'); // concat update pending when the core goes away
    expect(client.take()).toEqual(['didChange file:///w/src/my%20mod.py', `didChange ${NB}.cell0.py`]);

    client.reconnected();
    expect(client.takeAll()).toEqual([
      {
        method: 'textDocument/didOpen',
        params: { uri: `${NB}.cell0.py`, languageId: 'python', version: 2, text: 'a2' }
      },
      {
        method: 'textDocument/didOpen',
        params: { uri: `${NB}.cells.py`, languageId: 'python', version: 2, text: 'a2' }
      },
      {
        method: 'textDocument/didOpen',
        params: { uri: 'file:///w/src/my%20mod.py', languageId: 'python', version: 2, text: 'import sys' }
      }
    ]);
    // The replay carried the current concat text: the pending update is dropped.
    jest.advanceTimersByTime(CONCAT_DEBOUNCE_MS);
    expect(client.sent).toEqual([]);

    file.save();
    expect(client.take()).toEqual(['didSave file:///w/src/my%20mod.py']);
    file.dispose();
    expect(client.take()).toEqual(['didClose file:///w/src/my%20mod.py']);
    expect(sync.uriForFile(file)).toBeUndefined();

    sync.dispose();
    client.reconnected();
    a.sharedModel.setSource('a3');
    expect(client.sent).toEqual([]);
  });

  it('waits for the root dir and picks up widgets opened before it', async () => {
    const client = new FakeClient();
    const notebooks = new FakeTracker<FakeWidget<FakeNotebookModel>>();
    const editors = new FakeTracker<FakeWidget<{ sharedModel: FakeShared }>>();
    let resolveRoot!: (dir: string) => void;
    const rootDir = new Promise<string>((r) => (resolveRoot = r));
    const model = new FakeNotebookModel([new FakeCell('code', 'x')], python());
    notebooks.add(new FakeWidget(new FakeContext('nb/a.ipynb', model)));
    const sync = new DocumentSync(client, notebooks as never, editors as never, { rootDir });
    // A second view of the same notebook shares its context: synced once.
    const context2 = new FakeContext('nb/b.ipynb', new FakeNotebookModel([new FakeCell('code', 'y')], python()));
    notebooks.add(new FakeWidget(context2));
    notebooks.add(new FakeWidget(context2));
    await settle();
    expect(client.sent).toEqual([]);

    resolveRoot('/root dir/');
    await settle();
    expect(client.take().sort()).toEqual([
      'didOpen file:///root%20dir/nb/a.ipynb.cell0.py',
      'didOpen file:///root%20dir/nb/a.ipynb.cells.py',
      'didOpen file:///root%20dir/nb/b.ipynb.cell0.py',
      'didOpen file:///root%20dir/nb/b.ipynb.cells.py'
    ]);

    // A rename re-keys every virtual doc.
    context2.rename('nb/c.ipynb');
    expect(client.take()).toEqual([
      'didClose file:///root%20dir/nb/b.ipynb.cell0.py',
      'didClose file:///root%20dir/nb/b.ipynb.cells.py',
      'didOpen file:///root%20dir/nb/c.ipynb.cell0.py',
      'didOpen file:///root%20dir/nb/c.ipynb.cells.py'
    ]);
    sync.dispose();
  });

  it('syncs nothing when the root dir is unavailable or a document fails to load', async () => {
    const client = new FakeClient();
    const notebooks = new FakeTracker<FakeWidget<FakeNotebookModel>>();
    const editors = new FakeTracker<FakeWidget<{ sharedModel: FakeShared }>>();
    const model = new FakeNotebookModel([new FakeCell('code', 'x')], python());
    const noRoot = new DocumentSync(client, notebooks as never, editors as never, {
      rootDir: Promise.reject(new Error('404'))
    });
    notebooks.add(new FakeWidget(new FakeContext('nb/a.ipynb', model)));
    await settle();
    expect(client.sent).toEqual([]);
    noRoot.dispose();

    const sync = new DocumentSync(client, new FakeTracker() as never, editors as never, { rootDir: ROOT });
    const broken = new FakeContext('b.py', { sharedModel: new FakeShared('') });
    broken.ready = Promise.reject(new Error('load failed'));
    editors.add(new FakeWidget(broken));
    await settle();
    expect(client.sent).toEqual([]);
    sync.dispose();
  });

  it('tolerates a notebook closed before its content loaded', async () => {
    const client = new FakeClient();
    const notebooks = new FakeTracker<FakeWidget<FakeNotebookModel>>();
    const editors = new FakeTracker<FakeWidget<{ sharedModel: FakeShared }>>();
    const sync = new DocumentSync(client, notebooks as never, editors as never, { rootDir: ROOT });
    const context = new FakeContext('nb/a.ipynb', new FakeNotebookModel([new FakeCell('code', 'x')], python()));
    let loaded!: () => void;
    context.ready = new Promise<void>((r) => (loaded = r));
    notebooks.add(new FakeWidget(context));
    context.dispose();
    loaded();
    await settle();
    expect(client.sent).toEqual([]);
    sync.dispose();
  });
});
