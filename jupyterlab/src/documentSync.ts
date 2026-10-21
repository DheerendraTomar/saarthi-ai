import type { IDisposable } from '@lumino/disposable';
import type { ISignal } from '@lumino/signaling';
import { absPath, cellUri, concatUri, extForLanguage, fileUri, languageIdForPath } from './cellUri';
import type { WsCoreClient } from './client';

/** The part of `WsCoreClient` document sync uses (a fake in tests). */
export type SyncClient = Pick<WsCoreClient, 'notify' | 'onReconnect'>;

/** Quiet period before a notebook's concatenated `.cells.<ext>` document is re-sent. */
export const CONCAT_DEBOUNCE_MS = 200;

// The slices of the JupyterLab 4.5 objects read here, structurally typed so
// tests can use small fakes. `NotebookPanel` and `IDocumentWidget<FileEditor>`
// satisfy them.

/** A text shared model: `ISharedCell` / `ISharedFile`. Only `sourceChange` events matter. */
export interface SyncSharedText {
  getSource(): string;
  readonly changed: ISignal<unknown, { sourceChange?: unknown }>;
}

/** `ICellModel`. */
export interface SyncCell {
  readonly id: string;
  readonly type: string;
  readonly sharedModel: SyncSharedText;
}

/** `INotebookModel`. */
export interface SyncNotebookModel {
  readonly cells: { readonly length: number; get(index: number): SyncCell; readonly changed: ISignal<unknown, unknown> };
  getMetadata(key: string): unknown;
  readonly metadataChanged: ISignal<unknown, unknown>;
}

/** `DocumentRegistry.IContext` (shared by every view of a document). */
export interface SyncContext<M> {
  readonly localPath: string;
  readonly model: M;
  readonly ready: Promise<void>;
  readonly isDisposed: boolean;
  readonly saveState: ISignal<unknown, string>;
  readonly pathChanged: ISignal<unknown, string>;
  readonly disposed: ISignal<unknown, void>;
}

export interface SyncWidget<M> {
  readonly context: SyncContext<M>;
  readonly isDisposed: boolean;
  readonly disposed: ISignal<unknown, void>;
}

export type SyncNotebookPanel = SyncWidget<SyncNotebookModel>;
/** `IDocumentWidget<FileEditor>`: the editor's model is the context's, typed as text. */
export interface SyncEditorWidget extends SyncWidget<unknown> {
  readonly content: { readonly model: { readonly sharedModel: SyncSharedText } };
}

/** `INotebookTracker` / `IEditorTracker`. */
export interface SyncTracker<W> {
  readonly widgetAdded: ISignal<unknown, W>;
  forEach(fn: (widget: W) => void): void;
}

export interface DocumentSyncOptions {
  /** The Jupyter server's `root_dir` (the core's workspace), from `GET /localpilot/status`. */
  rootDir: string | Promise<string>;
}

interface CellDoc {
  cell: SyncCell;
  uri: string;
  version: number;
  off: () => void;
}

interface NotebookState {
  context: SyncContext<SyncNotebookModel>;
  /** Open views, most recent last (any of them can show the notebook). */
  panels: SyncNotebookPanel[];
  /** Cell id → its virtual document. */
  cells: Map<string, CellDoc>;
  /** `languageId` of every doc of the notebook (the kernel language, or `plaintext`). */
  languageId: string;
  concat?: { uri: string; version: number };
  timer?: ReturnType<typeof setTimeout>;
  off: Array<() => void>;
}

interface FileState {
  context: SyncContext<unknown>;
  text: SyncSharedText;
  uri: string;
  languageId: string;
  version: number;
  off: Array<() => void>;
}

function listen<T, A>(signal: ISignal<T, A>, fn: (sender: T, args: A) => void): () => void {
  signal.connect(fn);
  return () => {
    signal.disconnect(fn);
  };
}

/** Compares URIs by their decoded form: the core may encode a path differently. */
function sameUri(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return decodeURIComponent(a) === decodeURIComponent(b);
  } catch {
    return false;
  }
}

/** The kernel language of a notebook (`''` before the kernel reports it). */
function kernelLanguage(model: SyncNotebookModel): string {
  const info = model.getMetadata('language_info') as { name?: unknown } | undefined;
  const spec = model.getMetadata('kernelspec') as { language?: unknown } | undefined;
  const name = typeof info?.name === 'string' && info.name ? info.name : spec?.language;
  return typeof name === 'string' ? name.toLowerCase() : '';
}

/** All code cells, in order, separated by a blank line (as the VS Code client). */
function concatText(model: SyncNotebookModel): string {
  const parts: string[] = [];
  for (let i = 0; i < model.cells.length; i++) {
    const cell = model.cells.get(i);
    if (cell.type === 'code') parts.push(cell.sharedModel.getSource());
  }
  return parts.join('\n\n');
}

/**
 * Mirrors open notebooks and file editors into the core's overlay
 * (`textDocument/didOpen|didChange|didSave|didClose`), so completions and the
 * chat agent see unsaved text.
 *
 * - Each code cell is `file://<root>/<nb>.ipynb.cell<i>.<ext>` (ext from the
 *   kernel language) and every edit sends its full text at once; the
 *   `.cells.<ext>` concatenation is re-sent 200 ms after the last change.
 *   Structural changes (insert/move/delete, cell type, kernel language,
 *   rename) close the old virtual docs before opening the new ones.
 * - A file editor is `file://<root>/<path>`, also sent as full text.
 * - Saving a notebook or file sends `didSave`; closing it (the last view)
 *   sends `didClose` for all its docs.
 * - After the client re-initializes (`onReconnect`, a fresh core with an empty
 *   overlay) everything is re-opened. Nothing is replayed on the first
 *   connect: notifications sent before it are queued by the client.
 */
export class DocumentSync implements IDisposable {
  private root: string | undefined;
  private readonly notebooks = new Map<SyncContext<SyncNotebookModel>, NotebookState>();
  private readonly files = new Map<SyncContext<unknown>, FileState>();
  private readonly off: Array<() => void> = [];
  private disposed = false;

  constructor(
    private readonly client: SyncClient,
    notebookTracker: SyncTracker<SyncNotebookPanel> | null,
    editorTracker: SyncTracker<SyncEditorWidget> | null,
    options: DocumentSyncOptions
  ) {
    const reconnect = client.onReconnect(() => this.replayOpen());
    this.off.push(() => reconnect.dispose());
    // No root dir (status request failed): nothing is synced; the caller logs it.
    const rootDir = Promise.resolve(options.rootDir).catch(() => undefined);
    // A document that fails to load is simply not synced.
    const ignore = () => undefined;
    if (notebookTracker) {
      this.off.push(
        listen(notebookTracker.widgetAdded, (_, panel) => {
          rootDir.then(() => this.addNotebook(panel)).catch(ignore);
        })
      );
    }
    if (editorTracker) {
      this.off.push(
        listen(editorTracker.widgetAdded, (_, widget) => {
          rootDir.then(() => this.addFile(widget)).catch(ignore);
        })
      );
    }
    void rootDir.then((root) => {
      if (this.disposed || root === undefined) return;
      this.root = root;
      notebookTracker?.forEach((panel) => this.addNotebook(panel).catch(ignore));
      editorTracker?.forEach((widget) => this.addFile(widget).catch(ignore));
    });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Stops syncing (sends nothing: the client goes away with it). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.off.splice(0)) off();
    for (const st of this.notebooks.values()) {
      clearTimeout(st.timer);
      for (const doc of st.cells.values()) doc.off();
      for (const off of st.off) off();
    }
    for (const st of this.files.values()) for (const off of st.off) off();
    this.notebooks.clear();
    this.files.clear();
  }

  /**
   * The open code cell the core knows as `virtualUri`
   * (`file://<nb>.ipynb.cell<i>.<ext>`) with a view of its notebook; undefined
   * for anything else, including the `.cells.<ext>` concat doc.
   */
  cellForUri(virtualUri: string): { notebook: SyncNotebookPanel; cellId: string } | undefined {
    for (const st of this.notebooks.values()) {
      for (const [cellId, doc] of st.cells) {
        if (!sameUri(doc.uri, virtualUri)) continue;
        const notebook = st.panels[st.panels.length - 1];
        return notebook ? { notebook, cellId } : undefined;
      }
    }
    return undefined;
  }

  /** The virtual URI of a synced code cell; undefined for other cells and unsynced notebooks. */
  uriForCell(cell: Pick<SyncCell, 'id'>): string | undefined {
    for (const st of this.notebooks.values()) {
      const doc = st.cells.get(cell.id);
      if (doc) return doc.uri;
    }
    return undefined;
  }

  /** Whether `uri` is a document synced to the core (a code cell or a file editor's file). */
  isSynced(uri: string): boolean {
    if (this.cellForUri(uri)) return true;
    for (const st of this.files.values()) if (sameUri(st.uri, uri)) return true;
    return false;
  }

  /**
   * The `file://` URI of a synced file editor's document, by its context
   * (`IDocumentWidget.context`); undefined for untracked files and notebooks.
   */
  uriForFile(context: object): string | undefined {
    return this.files.get(context as SyncContext<unknown>)?.uri;
  }

  /** Re-sends `didOpen` for every synced document (a re-initialized core has an empty overlay). */
  replayOpen(): void {
    if (this.disposed) return;
    for (const st of this.notebooks.values()) {
      for (const doc of st.cells.values()) this.openCell(st, doc);
      if (st.concat) {
        clearTimeout(st.timer);
        st.timer = undefined;
        st.concat.version += 1;
        this.openConcat(st);
      }
    }
    for (const st of this.files.values()) this.openFile(st);
  }

  // ---------------------------------------------------------------- notebooks

  private async addNotebook(panel: SyncNotebookPanel): Promise<void> {
    const context = panel.context;
    await context.ready;
    if (this.disposed || this.root === undefined || panel.isDisposed || context.isDisposed) return;
    const known = this.notebooks.get(context);
    if (known) {
      if (!known.panels.includes(panel)) this.trackPanel(known, panel);
      return;
    }
    const model = context.model;
    const st: NotebookState = { context, panels: [], cells: new Map(), languageId: '', off: [] };
    st.off.push(
      listen(model.cells.changed, () => this.reconcile(st)),
      listen(model.metadataChanged, () => this.reconcile(st)),
      listen(context.pathChanged, () => {
        this.closeNotebookDocs(st);
        this.reconcile(st);
      }),
      listen(context.saveState, (_, state) => {
        if (state === 'completed') this.saveNotebook(st);
      }),
      listen(context.disposed, () => this.closeNotebook(st))
    );
    this.notebooks.set(context, st);
    this.trackPanel(st, panel);
    this.reconcile(st);
  }

  private trackPanel(st: NotebookState, panel: SyncNotebookPanel): void {
    st.panels.push(panel);
    const off = listen(panel.disposed, () => {
      off();
      st.panels = st.panels.filter((p) => p !== panel);
    });
    st.off.push(off);
  }

  /** Brings the core's virtual documents for a notebook in line with its current code cells. */
  private reconcile(st: NotebookState): void {
    if (this.root === undefined) return;
    const model = st.context.model;
    const nbPath = absPath(this.root, st.context.localPath);
    const language = kernelLanguage(model);
    const ext = extForLanguage(language);
    const languageId = language || 'plaintext';
    const relabel = st.languageId !== languageId;
    st.languageId = languageId;

    const desired = new Map<string, { cell: SyncCell; uri: string }>();
    for (let i = 0; i < model.cells.length; i++) {
      const cell = model.cells.get(i);
      if (cell.type === 'code') desired.set(cell.id, { cell, uri: cellUri(nbPath, i, ext) });
    }

    let changed = false;
    // Close every doc whose cell is gone or moved before opening new ones:
    // a swap reuses the other cell's uri.
    for (const [id, doc] of st.cells) {
      const want = desired.get(id);
      if (!relabel && want && want.uri === doc.uri && want.cell === doc.cell) continue;
      this.client.notify('textDocument/didClose', { uri: doc.uri });
      doc.off();
      st.cells.delete(id);
      changed = true;
    }
    for (const [id, { cell, uri }] of desired) {
      if (st.cells.has(id)) continue;
      const doc: CellDoc = { cell, uri, version: 1, off: () => undefined };
      doc.off = listen(cell.sharedModel.changed, (_, change) => {
        if (change.sourceChange !== undefined) this.cellEdited(st, doc);
      });
      st.cells.set(id, doc);
      this.openCell(st, doc);
      changed = true;
    }

    const wantConcat = desired.size > 0 ? concatUri(nbPath, ext) : undefined;
    if (st.concat && (relabel || st.concat.uri !== wantConcat)) {
      clearTimeout(st.timer);
      st.timer = undefined;
      this.client.notify('textDocument/didClose', { uri: st.concat.uri });
      st.concat = undefined;
    }
    if (wantConcat && !st.concat) {
      st.concat = { uri: wantConcat, version: 1 };
      this.openConcat(st);
    } else if (changed) {
      this.scheduleConcat(st);
    }
  }

  private openCell(st: NotebookState, doc: CellDoc): void {
    this.client.notify('textDocument/didOpen', {
      uri: doc.uri,
      languageId: st.languageId,
      version: doc.version,
      text: doc.cell.sharedModel.getSource()
    });
  }

  private openConcat(st: NotebookState): void {
    if (!st.concat) return;
    this.client.notify('textDocument/didOpen', {
      uri: st.concat.uri,
      languageId: st.languageId,
      version: st.concat.version,
      text: concatText(st.context.model)
    });
  }

  private cellEdited(st: NotebookState, doc: CellDoc): void {
    doc.version += 1;
    this.client.notify('textDocument/didChange', {
      uri: doc.uri,
      version: doc.version,
      contentChanges: [{ text: doc.cell.sharedModel.getSource() }]
    });
    this.scheduleConcat(st);
  }

  private scheduleConcat(st: NotebookState): void {
    if (!st.concat) return;
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = undefined;
      if (!st.concat) return;
      st.concat.version += 1;
      this.client.notify('textDocument/didChange', {
        uri: st.concat.uri,
        version: st.concat.version,
        contentChanges: [{ text: concatText(st.context.model) }]
      });
    }, CONCAT_DEBOUNCE_MS);
  }

  private saveNotebook(st: NotebookState): void {
    for (const doc of st.cells.values()) this.client.notify('textDocument/didSave', { uri: doc.uri });
    if (st.concat) this.client.notify('textDocument/didSave', { uri: st.concat.uri });
  }

  /** Sends `didClose` for every virtual doc of the notebook and forgets them (the state stays). */
  private closeNotebookDocs(st: NotebookState): void {
    clearTimeout(st.timer);
    st.timer = undefined;
    for (const doc of st.cells.values()) {
      this.client.notify('textDocument/didClose', { uri: doc.uri });
      doc.off();
    }
    st.cells.clear();
    if (st.concat) this.client.notify('textDocument/didClose', { uri: st.concat.uri });
    st.concat = undefined;
  }

  private closeNotebook(st: NotebookState): void {
    this.closeNotebookDocs(st);
    for (const off of st.off) off();
    this.notebooks.delete(st.context);
  }

  // ---------------------------------------------------------------- file editors

  private async addFile(widget: SyncEditorWidget): Promise<void> {
    const context = widget.context;
    await context.ready;
    if (this.disposed || this.root === undefined || widget.isDisposed || context.isDisposed) return;
    if (this.files.has(context)) return;
    const text = widget.content.model.sharedModel;
    const st: FileState = { context, text, uri: '', languageId: '', version: 1, off: [] };
    this.setFilePath(st);
    st.off.push(
      listen(text.changed, (_, change) => {
        if (change.sourceChange === undefined) return;
        st.version += 1;
        this.client.notify('textDocument/didChange', {
          uri: st.uri,
          version: st.version,
          contentChanges: [{ text: text.getSource() }]
        });
      }),
      listen(context.pathChanged, () => {
        this.client.notify('textDocument/didClose', { uri: st.uri });
        this.setFilePath(st);
        this.openFile(st);
      }),
      listen(context.saveState, (_, state) => {
        if (state === 'completed') this.client.notify('textDocument/didSave', { uri: st.uri });
      }),
      listen(context.disposed, () => {
        this.client.notify('textDocument/didClose', { uri: st.uri });
        for (const off of st.off) off();
        this.files.delete(context);
      })
    );
    this.files.set(context, st);
    this.openFile(st);
  }

  private setFilePath(st: FileState): void {
    st.uri = fileUri(absPath(this.root ?? '', st.context.localPath));
    st.languageId = languageIdForPath(st.context.localPath);
  }

  private openFile(st: FileState): void {
    this.client.notify('textDocument/didOpen', {
      uri: st.uri,
      languageId: st.languageId,
      version: st.version,
      text: st.text.getSource()
    });
  }
}
