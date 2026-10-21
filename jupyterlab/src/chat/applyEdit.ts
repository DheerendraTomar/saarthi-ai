import { serverPathForUri } from '../cellUri';

/** Wire types of the core→client `workspace/applyEdit` request (core/src/protocol.rs). */
export interface WireRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export type EditOp =
  | { kind: 'edit'; uri: string; range: WireRange; newText: string }
  | { kind: 'create'; uri: string; content: string };

export interface ApplyEditParams {
  ops: EditOp[];
  save: boolean;
  /** The chat session that asked (the server bridge routed the request by it). */
  sessionId?: string;
}

export interface ApplyEditResult {
  applied: boolean;
  error?: string;
}

// The slices of the JupyterLab 4.5 objects used here, structurally typed so
// tests can use small fakes. `ICellModel`, `NotebookPanel`, `IDocumentManager`,
// `DocumentRegistry.Context` and `Contents.IManager` satisfy them.

/** `ISharedText` (a cell's or a file's Yjs model): offsets are UTF-16 code units. */
export interface EditText {
  getSource(): string;
  updateSource(start: number, end: number, value: string): void;
}

/** `ICellModel`. */
export interface EditCell {
  readonly id: string;
  readonly sharedModel: EditText;
}

/** `NotebookPanel` (its context: the model's cell list, and save). */
export interface EditNotebook {
  readonly context: {
    readonly isDisposed: boolean;
    readonly model: { readonly cells: { readonly length: number; get(index: number): EditCell } };
    save(): Promise<void>;
  };
}

/** `DocumentRegistry.Context` of a text file. */
export interface EditFileContext {
  readonly ready: Promise<void>;
  readonly isDisposed: boolean;
  /** A text file's model is `ISharedFile` (an `EditText`); checked at run time. */
  readonly model: { readonly sharedModel: object };
  save(): Promise<void>;
}

/** `IDocumentManager`. */
export interface EditDocManager {
  findWidget(path: string): object | undefined;
  open(path: string, widgetName?: string, kernel?: undefined, options?: { activate?: boolean }): object | undefined;
  contextForWidget(widget: object): EditFileContext | undefined;
}

/** `Contents.IManager` (create only). */
export interface EditContents {
  get(path: string, options?: { content?: boolean }): Promise<unknown>;
  save(path: string, options?: { type?: 'file' | 'directory'; format?: 'text'; content?: string }): Promise<unknown>;
}

export interface ApplyEditOptions {
  /** `DocumentSync.cellForUri`: the virtual cell URI → its notebook view and the cell's id. */
  resolveCell?: (virtualUri: string) => { notebook: EditNotebook; cellId: string } | undefined;
  /** The Jupyter server's `root_dir`; file URIs are mapped to server paths below it. */
  rootDir?: string | Promise<string>;
  docManager?: EditDocManager;
  contents?: EditContents;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `<nb>.ipynb.cells.<ext>`: the read-only concatenation of a notebook's code cells. */
const CONCAT_PATH = /\.ipynb\.cells\.[^./\\]+$/;
/** `<nb>.ipynb.cell<i>.<ext>`: one code cell, synced under a virtual file path. */
const CELL_PATH = /\.ipynb\.cell\d+\.[^./\\]+$/;
/** A notebook file: never opened for a text edit (that would start a kernel). */
const NOTEBOOK_PATH = /\.ipynb$/i;

/** One resolved op, ready to apply. */
interface Planned {
  text: EditText;
  start: number;
  end: number;
  newText: string;
  save: () => Promise<void>;
  /** Notebook or file context: each saved once. */
  key: object;
  label: string;
}

/**
 * UTF-16 offsets of an LSP range in `source` (JS strings are UTF-16, so a
 * `character` is a string index within its line). A range outside the text
 * means the core edited a stale copy: refused, not clamped.
 */
function offsets(source: string, range: WireRange): [number, number] | undefined {
  const lines = source.split('\n');
  const at = (p: { line: number; character: number }): number | undefined => {
    if (!Number.isInteger(p?.line) || !Number.isInteger(p?.character) || p.line < 0 || p.character < 0) return undefined;
    if (p.line >= lines.length || p.character > lines[p.line].length) return undefined;
    let offset = 0;
    for (let i = 0; i < p.line; i++) offset += lines[i].length + 1;
    return offset + p.character;
  };
  const start = at(range?.start);
  const end = at(range?.end);
  return start === undefined || end === undefined || end < start ? undefined : [start, end];
}

/** The cell with `id` in the notebook's current cell list (its index may have changed). */
function findCell(notebook: EditNotebook, id: string): EditCell | undefined {
  const cells = notebook.context.model.cells;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells.get(i);
    if (cell.id === id) return cell;
  }
  return undefined;
}

const isNotFound = (e: unknown) => (e as { response?: { status?: number } })?.response?.status === 404;

async function exists(contents: EditContents, path: string): Promise<boolean> {
  try {
    await contents.get(path, { content: false });
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/**
 * Applies an approved agent edit (the core's `workspace/applyEdit`). Every op
 * is resolved and checked before anything changes, and every op that needs
 * no open document (kinds, paths, cells, creates) before any file is opened;
 * a `.ipynb` path is refused (edit its cells). If an edit applied but a save
 * failed, the result is `{applied: false, error}` with the unsaved paths. Notebook cells arrive under
 * their virtual `<nb>.ipynb.cell<i>.<ext>` URI: `resolveCell` maps it to the
 * notebook and the cell's id, and the cell is looked up by that id in the
 * notebook's model (a deleted cell fails cleanly) and edited through
 * `sharedModel.updateSource`. The concatenated `.cells.<ext>` doc and new cells
 * are refused. Files under the server root are edited in their document model
 * (opened in the background through the document manager when not open);
 * `create` writes a new file through the contents API and refuses an existing
 * one. With `save`, each touched notebook / file is saved once. Never throws.
 */
export async function applyEdit(params: ApplyEditParams, opts: ApplyEditOptions = {}): Promise<ApplyEditResult> {
  const planned: Planned[] = [];
  const creates: Array<{ path: string; content: string }> = [];
  let rootDir: string | undefined;
  const serverPath = async (uri: string): Promise<string> => {
    if (rootDir === undefined) {
      try {
        rootDir = await opts.rootDir;
      } catch (e) {
        throw new Error(`the Jupyter root directory is unknown (${message(e)})`);
      }
      if (!rootDir) throw new Error('the Jupyter root directory is unknown');
    }
    const path = serverPathForUri(rootDir, uri);
    if (path === undefined) throw new Error(`${uri} is outside the Jupyter root ${rootDir}`);
    return path;
  };

  // Phase 1: everything that can be checked without opening a document —
  // op kinds, paths, the cell rules (cells are open already, so their ranges
  // too) and `create` targets — so a bad op refuses the edit before any file
  // is opened (opening has side effects: a notebook would start a kernel).
  const fileEdits: Array<{ uri: string; path: string; range: WireRange; newText: string }> = [];
  try {
    if (!Array.isArray(params?.ops)) return { applied: false, error: 'invalid edit: no ops' };
    for (const op of params.ops) {
      const uri = typeof op?.uri === 'string' ? op.uri : '';
      if (CONCAT_PATH.test(uri)) {
        return { applied: false, error: `${uri} is the read-only view of a notebook's cells; edit a single cell (.cell<N>) instead` };
      }
      if (CELL_PATH.test(uri)) {
        if (op.kind === 'create') return { applied: false, error: `LocalPilot can't create notebook cells (${uri})` };
        if (op.kind !== 'edit') return { applied: false, error: `unknown edit op ${JSON.stringify((op as { kind?: unknown }).kind)}` };
        const found = opts.resolveCell?.(uri);
        if (!found || found.notebook.context.isDisposed) {
          return { applied: false, error: `cannot edit ${uri}: that notebook cell is not open` };
        }
        const cell = findCell(found.notebook, found.cellId);
        if (!cell) return { applied: false, error: `cannot edit ${uri}: the cell is no longer in the notebook` };
        const at = offsets(cell.sharedModel.getSource(), op.range);
        if (!at) return { applied: false, error: `cannot edit ${uri}: the range is outside the cell's current text` };
        const context = found.notebook.context;
        planned.push({ text: cell.sharedModel, start: at[0], end: at[1], newText: String(op.newText ?? ''), save: () => context.save(), key: context, label: uri });
        continue;
      }
      if (op.kind === 'edit') {
        const path = await serverPath(uri);
        if (NOTEBOOK_PATH.test(path)) {
          return { applied: false, error: `cannot edit ${path} as text: edit its cells (.cell<N>) instead` };
        }
        if (!opts.docManager) return { applied: false, error: `cannot open ${uri}: no document manager` };
        fileEdits.push({ uri, path, range: op.range, newText: String(op.newText ?? '') });
      } else if (op.kind === 'create') {
        const path = await serverPath(uri);
        if (!opts.contents) return { applied: false, error: `cannot create ${path}: no contents manager` };
        if (await exists(opts.contents, path)) return { applied: false, error: `cannot create ${path}: it already exists` };
        creates.push({ path, content: String(op.content ?? '') });
      } else {
        return { applied: false, error: `unknown edit op ${JSON.stringify((op as { kind?: unknown }).kind)}` };
      }
    }

    // Phase 2: open the files (in the background) and check their ranges.
    const dm = opts.docManager;
    for (const edit of fileEdits) {
      if (!dm) break; // checked in phase 1
      const widget = dm.findWidget(edit.path) ?? dm.open(edit.path, 'default', undefined, { activate: false });
      const context = widget ? dm.contextForWidget(widget) : undefined;
      if (!context) return { applied: false, error: `cannot open ${edit.path}` };
      await context.ready;
      const text = context.model?.sharedModel as Partial<EditText> | undefined;
      if (typeof text?.getSource !== 'function' || typeof text.updateSource !== 'function') {
        return { applied: false, error: `${edit.path} is not a text document` };
      }
      const at = offsets(text.getSource(), edit.range);
      if (!at) return { applied: false, error: `cannot edit ${edit.path}: the range is outside the file's current text` };
      planned.push({
        text: text as EditText,
        start: at[0],
        end: at[1],
        newText: edit.newText,
        save: () => context.save(),
        key: context,
        label: edit.path
      });
    }
  } catch (e) {
    return { applied: false, error: `invalid edit: ${message(e)}` };
  }

  const contents = opts.contents;
  try {
    for (const p of planned) p.text.updateSource(p.start, p.end, p.newText);
    for (const c of creates) {
      if (!contents) break; // checked while planning
      // The contents API does not create parents.
      const parts = c.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (!(await exists(contents, dir))) await contents.save(dir, { type: 'directory' });
      }
      await contents.save(c.path, { type: 'file', format: 'text', content: c.content });
    }
  } catch (e) {
    return { applied: false, error: `applying the edit failed: ${message(e)}` };
  }
  if (!params.save) return { applied: true };

  const unsaved: string[] = [];
  const saved = new Set<object>();
  for (const p of planned) {
    if (saved.has(p.key)) continue;
    saved.add(p.key);
    try {
      await p.save();
    } catch (e) {
      unsaved.push(`${p.label} (${message(e)})`);
    }
  }
  // Not `applied: true`: the core would report the edit as applied and saved.
  return unsaved.length ? { applied: false, error: `applied but could not save ${unsaved.join(', ')}` } : { applied: true };
}
