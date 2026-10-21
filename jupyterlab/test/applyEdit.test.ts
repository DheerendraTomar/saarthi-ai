import { applyEdit, type ApplyEditOptions, type EditCell, type EditFileContext } from '../src/chat/applyEdit';

// Stand-ins for the JupyterLab objects applyEdit touches: a notebook panel's
// context (cells by index, save), a cell / file shared model (Yjs-style
// updateSource with UTF-16 offsets), the document manager and contents API.

class FakeText {
  updates: Array<[number, number, string]> = [];
  constructor(public source: string) {}
  getSource(): string {
    return this.source;
  }
  updateSource(start: number, end: number, value: string): void {
    this.updates.push([start, end, value]);
    this.source = this.source.slice(0, start) + value + this.source.slice(end);
  }
}

function cell(id: string, source: string): EditCell & { sharedModel: FakeText } {
  return { id, sharedModel: new FakeText(source) };
}

function notebook(cells: Array<EditCell & { sharedModel: FakeText }>) {
  const context = {
    isDisposed: false,
    save: jest.fn(async () => undefined),
    model: {
      cells: {
        get length() {
          return cells.length;
        },
        get: (i: number) => cells[i]
      }
    }
  };
  return { context, cells };
}

const ROOT = '/home/me/work';
const CELL1 = 'file:///home/me/work/nb.ipynb.cell1.py';

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec }
});

describe('applyEdit: notebook cells', () => {
  it('applyEdit_edits_cell_by_id_and_saves', async () => {
    const first = cell('a', 'import os\n');
    const target = cell('b', 'x = 1\ny = "é😀z"\n');
    const nb = notebook([first, target]);
    // The cell the URI was synced for is found by id, wherever it now sits.
    nb.cells.reverse();
    const resolveCell = jest.fn(() => ({ notebook: nb, cellId: 'b' }));

    const result = await applyEdit(
      // Replace `z` (after a BMP char and a surrogate pair: UTF-16 offset 5+1+2 on line 1).
      { ops: [{ kind: 'edit', uri: CELL1, range: range(1, 8, 1, 9), newText: 'w' }], save: true, sessionId: 's1' },
      { resolveCell, rootDir: ROOT }
    );

    expect(result).toEqual({ applied: true });
    expect(resolveCell).toHaveBeenCalledWith(CELL1);
    expect(target.sharedModel.updates).toEqual([[14, 15, 'w']]);
    expect(target.sharedModel.source).toBe('x = 1\ny = "é😀w"\n');
    expect(first.sharedModel.updates).toEqual([]);
    expect(nb.context.save).toHaveBeenCalledTimes(1);
  });

  it('applyEdit_fails_cleanly_when_cell_gone', async () => {
    const nb = notebook([cell('a', 'print(1)\n')]);
    const result = await applyEdit(
      { ops: [{ kind: 'edit', uri: CELL1, range: range(0, 0, 0, 5), newText: 'x' }], save: true },
      { resolveCell: () => ({ notebook: nb, cellId: 'deleted' }), rootDir: ROOT }
    );
    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/no longer in the notebook/);
    expect(nb.cells[0].sharedModel.updates).toEqual([]);
    expect(nb.context.save).not.toHaveBeenCalled();

    // Not synced (notebook closed): also a clean refusal.
    const closed = await applyEdit(
      { ops: [{ kind: 'edit', uri: CELL1, range: range(0, 0, 0, 0), newText: 'x' }], save: true },
      { resolveCell: () => undefined, rootDir: ROOT }
    );
    expect(closed).toEqual({ applied: false, error: expect.stringMatching(/not open/) });
  });

  it('refuses_concat_doc_create_on_cell_and_out_of_range', async () => {
    const nb = notebook([cell('a', 'one\ntwo')]);
    const opts: ApplyEditOptions = { resolveCell: () => ({ notebook: nb, cellId: 'a' }), rootDir: ROOT };
    const concat = await applyEdit(
      { ops: [{ kind: 'edit', uri: 'file:///home/me/work/nb.ipynb.cells.py', range: range(0, 0, 0, 1), newText: 'x' }], save: true },
      opts
    );
    expect(concat.applied).toBe(false);
    expect(concat.error).toMatch(/read-only view/);

    const create = await applyEdit({ ops: [{ kind: 'create', uri: CELL1, content: 'x' }], save: true }, opts);
    expect(create.applied).toBe(false);
    expect(create.error).toMatch(/can't create notebook cells/);

    const stale = await applyEdit({ ops: [{ kind: 'edit', uri: CELL1, range: range(1, 0, 1, 9), newText: 'x' }], save: true }, opts);
    expect(stale.applied).toBe(false);
    expect(stale.error).toMatch(/outside/);
    expect(nb.cells[0].sharedModel.updates).toEqual([]);
    expect(nb.context.save).not.toHaveBeenCalled();
  });
});

describe('applyEdit: files', () => {
  function docManager(open: Record<string, EditFileContext>, closed: Record<string, EditFileContext> = {}) {
    const widgets = new Map<object, EditFileContext>();
    const widgetFor = (ctx: EditFileContext) => {
      const w = { ctx };
      widgets.set(w, ctx);
      return w;
    };
    return {
      findWidget: jest.fn((path: string) => (open[path] ? widgetFor(open[path]) : undefined)),
      open: jest.fn((path: string) => (closed[path] ? widgetFor(closed[path]) : undefined)),
      contextForWidget: jest.fn((w: object) => widgets.get(w))
    };
  }
  function fileContext(source: string) {
    return {
      ready: Promise.resolve(),
      isDisposed: false,
      save: jest.fn(async () => undefined),
      model: { sharedModel: new FakeText(source) }
    };
  }

  it('applyEdit_edits_file_model_and_saves', async () => {
    const ctx = fileContext('def f():\n    return 1\n');
    const dm = docManager({ 'pkg/my mod.py': ctx });
    const result = await applyEdit(
      {
        ops: [{ kind: 'edit', uri: 'file:///home/me/work/pkg/my%20mod.py', range: range(1, 11, 1, 12), newText: '2' }],
        save: true
      },
      { rootDir: Promise.resolve(ROOT), docManager: dm }
    );
    expect(result).toEqual({ applied: true });
    expect(dm.findWidget).toHaveBeenCalledWith('pkg/my mod.py');
    expect(ctx.model.sharedModel.source).toBe('def f():\n    return 2\n');
    expect(ctx.save).toHaveBeenCalledTimes(1);
  });

  it('opens_a_closed_file_in_the_background', async () => {
    const ctx = fileContext('a\n');
    const dm = docManager({}, { 'b.txt': ctx });
    const result = await applyEdit(
      { ops: [{ kind: 'edit', uri: 'file:///home/me/work/b.txt', range: range(0, 0, 0, 1), newText: 'b' }], save: false },
      { rootDir: ROOT, docManager: dm }
    );
    expect(result).toEqual({ applied: true });
    expect(dm.open).toHaveBeenCalledWith('b.txt', 'default', undefined, { activate: false });
    expect(ctx.model.sharedModel.source).toBe('b\n');
    expect(ctx.save).not.toHaveBeenCalled();
  });

  it('refuses_files_outside_the_root', async () => {
    const dm = docManager({});
    const result = await applyEdit(
      { ops: [{ kind: 'edit', uri: 'file:///etc/passwd', range: range(0, 0, 0, 0), newText: 'x' }], save: true },
      { rootDir: ROOT, docManager: dm }
    );
    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/outside the Jupyter root/);
    expect(dm.findWidget).not.toHaveBeenCalled();
  });

  it('validates_every_op_before_opening_any_file', async () => {
    const ctx = fileContext('a\n');
    const dm = docManager({}, { 'b.txt': ctx });
    const bogus = await applyEdit(
      {
        ops: [
          { kind: 'edit', uri: 'file:///home/me/work/b.txt', range: range(0, 0, 0, 1), newText: 'b' },
          { kind: 'bogus', uri: 'file:///home/me/work/c.txt' } as never
        ],
        save: true
      },
      { rootDir: ROOT, docManager: dm }
    );
    expect(bogus).toEqual({ applied: false, error: expect.stringMatching(/unknown edit op "bogus"/) });
    const outside = await applyEdit(
      {
        ops: [
          { kind: 'edit', uri: 'file:///home/me/work/b.txt', range: range(0, 0, 0, 1), newText: 'b' },
          { kind: 'edit', uri: 'file:///etc/hosts', range: range(0, 0, 0, 0), newText: 'x' }
        ],
        save: true
      },
      { rootDir: ROOT, docManager: dm }
    );
    expect(outside.applied).toBe(false);
    expect(dm.findWidget).not.toHaveBeenCalled();
    expect(dm.open).not.toHaveBeenCalled();
    expect(ctx.model.sharedModel.updates).toEqual([]);
  });

  it('refuses_a_text_edit_of_a_notebook_without_opening_it', async () => {
    const dm = docManager({});
    const result = await applyEdit(
      { ops: [{ kind: 'edit', uri: 'file:///home/me/work/nb.ipynb', range: range(0, 0, 0, 0), newText: 'x' }], save: true },
      { rootDir: ROOT, docManager: dm }
    );
    expect(result).toEqual({ applied: false, error: expect.stringMatching(/nb\.ipynb as text: edit its cells/) });
    expect(dm.findWidget).not.toHaveBeenCalled();
    expect(dm.open).not.toHaveBeenCalled();
  });

  it('reports_not_applied_when_the_save_fails', async () => {
    const ctx = fileContext('a\n');
    ctx.save.mockRejectedValueOnce(new Error('disk full'));
    const dm = docManager({ 'b.txt': ctx });
    const result = await applyEdit(
      { ops: [{ kind: 'edit', uri: 'file:///home/me/work/b.txt', range: range(0, 0, 0, 1), newText: 'b' }], save: true },
      { rootDir: ROOT, docManager: dm }
    );
    // The text changed in the editor, but the core must not report "applied and saved".
    expect(result).toEqual({ applied: false, error: 'applied but could not save b.txt (disk full)' });
    expect(ctx.model.sharedModel.source).toBe('b\n');
  });

  it('creates_a_new_file_through_the_contents_api', async () => {
    const saved: Array<[string, unknown]> = [];
    const contents = {
      get: jest.fn(async (path: string) => {
        if (path === 'exists.py') return { type: 'file' };
        throw Object.assign(new Error('not found'), { response: { status: 404 } });
      }),
      save: jest.fn(async (path: string, model: unknown) => {
        saved.push([path, model]);
        return {};
      })
    };
    const ok = await applyEdit(
      { ops: [{ kind: 'create', uri: 'file:///home/me/work/new/dir/m.py', content: 'x = 1\n' }], save: true },
      { rootDir: ROOT, contents }
    );
    expect(ok).toEqual({ applied: true });
    expect(saved).toEqual([
      ['new', { type: 'directory' }],
      ['new/dir', { type: 'directory' }],
      ['new/dir/m.py', { type: 'file', format: 'text', content: 'x = 1\n' }]
    ]);

    const exists = await applyEdit(
      { ops: [{ kind: 'create', uri: 'file:///home/me/work/exists.py', content: '' }], save: true },
      { rootDir: ROOT, contents }
    );
    expect(exists).toEqual({ applied: false, error: expect.stringMatching(/already exists/) });
  });
});
