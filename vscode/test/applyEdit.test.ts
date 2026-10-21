import { beforeEach, describe, expect, it } from "vitest";
import { applyEdit } from "../src/chat/applyEdit";
import { Uri, WorkspaceEdit, resetMock, workspaceFns } from "./mocks/vscode";

interface MockDoc {
  uri: Uri;
  isDirty: boolean;
  saves: number;
  save(): Promise<boolean>;
}

/** Documents by URI string; `openTextDocument` hands them out and records each open. */
let docs: Map<string, MockDoc>;
let opened: string[];
let applied: WorkspaceEdit[];

function mockDoc(uri: string, isDirty = false): MockDoc {
  const doc: MockDoc = {
    uri: Uri.parse(uri),
    isDirty,
    saves: 0,
    async save() {
      doc.saves += 1;
      doc.isDirty = false;
      return true;
    },
  };
  docs.set(uri, doc);
  return doc;
}

const A = "file:///work/proj/src/a.ts";
const B = "file:///work/proj/src/b.ts";
const OTHER = "file:///work/proj/src/other.ts";
const NEW = "file:///work/proj/src/new.ts";

const range = (l1: number, c1: number, l2: number, c2: number) => ({
  start: { line: l1, character: c1 },
  end: { line: l2, character: c2 },
});

beforeEach(() => {
  resetMock();
  docs = new Map();
  opened = [];
  applied = [];
  workspaceFns.openTextDocument = async (uri: Uri) => {
    const key = uri.toString();
    opened.push(key);
    const doc = docs.get(key);
    if (!doc) throw new Error(`cannot open ${key}: file not found`);
    return doc;
  };
  workspaceFns.applyEdit = async (edit: WorkspaceEdit) => {
    applied.push(edit);
    // Applying text edits makes the touched documents dirty, like VS Code.
    for (const op of edit.ops) {
      const doc = docs.get(op.uri.toString());
      if (doc) doc.isDirty = true;
      else if (op.kind === "createFile") mockDoc(op.uri.toString(), false);
    }
    return true;
  };
});

describe("applyEdit", () => {
  it("applyEdit_replaces_range_saves_touched_only", async () => {
    const a = mockDoc(A);
    const b = mockDoc(B);
    const other = mockDoc(OTHER, true); // dirty, but not part of the edit

    const result = await applyEdit({
      ops: [
        { kind: "edit", uri: A, range: range(1, 2, 1, 5), newText: "foo" },
        { kind: "edit", uri: A, range: range(3, 0, 4, 0), newText: "" },
        { kind: "edit", uri: B, range: range(0, 0, 0, 0), newText: "import x;\n" },
      ],
      save: true,
    });

    expect(result).toEqual({ applied: true });
    // One WorkspaceEdit (one undo step) carrying every op with its exact range and text.
    expect(applied).toHaveLength(1);
    expect(
      applied[0].ops.map((op) => {
        if (op.kind !== "replace") throw new Error("unexpected op");
        const r = op.range;
        return [op.uri.toString(), r.start.line, r.start.character, r.end.line, r.end.character, op.newText];
      }),
    ).toEqual([
      [A, 1, 2, 1, 5, "foo"],
      [A, 3, 0, 4, 0, ""],
      [B, 0, 0, 0, 0, "import x;\n"],
    ]);
    // Files are opened before editing; each touched file saved exactly once; others untouched.
    expect(opened).toContain(A);
    expect(opened).toContain(B);
    expect(a.saves).toBe(1);
    expect(b.saves).toBe(1);
    expect(other.saves).toBe(0);
    expect(other.isDirty).toBe(true);
  });

  it("applyEdit_does_not_save_when_save_is_false", async () => {
    const a = mockDoc(A);
    const result = await applyEdit({ ops: [{ kind: "edit", uri: A, range: range(0, 0, 0, 0), newText: "x" }], save: false });
    expect(result).toEqual({ applied: true });
    expect(a.saves).toBe(0);
    expect(a.isDirty).toBe(true);
  });

  it("applyEdit_creates_file_and_saves", async () => {
    const result = await applyEdit({ ops: [{ kind: "create", uri: NEW, content: "export const x = 1;\n// é\n" }], save: true });

    expect(result).toEqual({ applied: true });
    expect(applied).toHaveLength(1);
    const [op] = applied[0].ops;
    if (op.kind !== "createFile") throw new Error("expected createFile");
    expect(op.uri.toString()).toBe(NEW);
    // Never overwrites an existing file: VS Code then fails the edit instead.
    expect(op.options?.overwrite).toBeUndefined();
    expect(new TextDecoder().decode(op.options?.contents)).toBe("export const x = 1;\n// é\n");
    expect(docs.get(NEW)?.saves).toBe(1);
  });

  it("applyEdit_returns_error_not_throw_on_failure", async () => {
    // 1. A file that cannot be opened.
    const missing = await applyEdit({
      ops: [{ kind: "edit", uri: "file:///work/proj/gone.ts", range: range(0, 0, 0, 0), newText: "x" }],
      save: true,
    });
    expect(missing.applied).toBe(false);
    expect(missing.error).toMatch(/gone\.ts/);
    expect(applied).toHaveLength(0);

    // 2. VS Code refuses the edit (e.g. the file to create already exists).
    workspaceFns.applyEdit = async () => false;
    const refused = await applyEdit({ ops: [{ kind: "create", uri: NEW, content: "x" }], save: true });
    expect(refused.applied).toBe(false);
    expect(refused.error).toMatch(/new\.ts/);

    // 3. applyEdit itself throws.
    workspaceFns.applyEdit = async () => {
      throw new Error("boom");
    };
    mockDoc(A);
    const thrown = await applyEdit({ ops: [{ kind: "edit", uri: A, range: range(0, 0, 0, 0), newText: "x" }], save: true });
    expect(thrown).toEqual({ applied: false, error: expect.stringMatching(/boom/) });

    // 4. Applied, but the save fails: reported as an error, with applied still true.
    workspaceFns.applyEdit = async (edit) => {
      for (const op of edit.ops) docs.get(op.uri.toString())!.isDirty = true;
      return true;
    };
    const a = mockDoc(A);
    a.save = async () => false;
    const unsaved = await applyEdit({ ops: [{ kind: "edit", uri: A, range: range(0, 0, 0, 0), newText: "x" }], save: true });
    expect(unsaved.applied).toBe(true);
    expect(unsaved.error).toMatch(/save/i);

    // 5. Malformed params never throw either.
    const bad = await applyEdit({ ops: [{ kind: "edit", uri: "::not a uri", range: range(0, 0, 0, 0), newText: "" }], save: false });
    expect(bad.applied).toBe(false);
    expect(typeof bad.error).toBe("string");
  });

  describe("notebook cells", () => {
    const NB = "/work/proj/nb.ipynb";
    const CELL0 = `file://${NB}.cell0.py`;
    const CELL2 = `file://${NB}.cell2.py`;

    function notebook() {
      const nb = {
        uri: Uri.file(NB),
        isDirty: false,
        saves: 0,
        async save() {
          nb.saves += 1;
          nb.isDirty = false;
          return true;
        },
      };
      const cell = (i: number) => ({ uri: Uri.from({ scheme: "vscode-notebook-cell", path: NB, fragment: `W${i}` }) });
      const cells = new Map([
        [CELL0, cell(0)],
        [CELL2, cell(2)],
      ]);
      const resolveCell = (uri: string) => {
        const document = cells.get(uri);
        return document ? { document: document as never, notebook: nb as never } : undefined;
      };
      workspaceFns.applyEdit = async (edit: WorkspaceEdit) => {
        applied.push(edit);
        nb.isDirty = true; // editing a cell dirties its notebook
        return true;
      };
      return { nb, cells, resolveCell };
    }

    it("applyEdit_edits_a_cell_through_its_virtual_uri_and_saves_the_notebook", async () => {
      const { nb, cells, resolveCell } = notebook();
      const result = await applyEdit(
        {
          ops: [
            { kind: "edit", uri: CELL0, range: range(0, 0, 0, 0), newText: "import os\n" },
            { kind: "edit", uri: CELL2, range: range(1, 2, 1, 4), newText: "y" },
          ],
          save: true,
        },
        { resolveCell },
      );
      expect(result).toEqual({ applied: true });
      // The edits target the cell documents, never the (non-existent) virtual files.
      expect(applied).toHaveLength(1);
      expect(applied[0].ops.map((op) => (op.kind === "replace" ? [op.uri, op.newText] : op.kind))).toEqual([
        [cells.get(CELL0)!.uri, "import os\n"],
        [cells.get(CELL2)!.uri, "y"],
      ]);
      expect(opened).toEqual([]);
      // Saved through the notebook, once for both cells.
      expect(nb.saves).toBe(1);
      expect(nb.isDirty).toBe(false);
    });

    it("applyEdit_reports_an_unsaved_notebook_and_skips_save_when_not_asked", async () => {
      const { nb, resolveCell } = notebook();
      const noSave = await applyEdit({ ops: [{ kind: "edit", uri: CELL0, range: range(0, 0, 0, 0), newText: "x" }], save: false }, { resolveCell });
      expect(noSave).toEqual({ applied: true });
      expect(nb.saves).toBe(0);

      nb.save = async () => false; // stays dirty
      const failed = await applyEdit({ ops: [{ kind: "edit", uri: CELL0, range: range(0, 0, 0, 0), newText: "x" }], save: true }, { resolveCell });
      expect(failed.applied).toBe(true);
      expect(failed.error).toMatch(/could not save .*nb\.ipynb/);
    });

    it("applyEdit_rejects_concat_uri_create_on_cell_and_closed_cells", async () => {
      const { resolveCell } = notebook();
      const concat = await applyEdit(
        { ops: [{ kind: "edit", uri: `file://${NB}.cells.py`, range: range(0, 0, 0, 0), newText: "x" }], save: true },
        { resolveCell },
      );
      expect(concat.applied).toBe(false);
      expect(concat.error).toMatch(/cells\.py/);
      expect(concat.error).toMatch(/notebook/i);

      const create = await applyEdit({ ops: [{ kind: "create", uri: `file://${NB}.cell5.py`, content: "x" }], save: true }, { resolveCell });
      expect(create).toEqual({ applied: false, error: expect.stringContaining("LocalPilot can't create notebook cells") });

      // A cell URI that no open notebook has (closed meanwhile, or no resolver at all).
      const closed = await applyEdit({ ops: [{ kind: "edit", uri: `file://${NB}.cell7.py`, range: range(0, 0, 0, 0), newText: "x" }], save: true }, { resolveCell });
      expect(closed.applied).toBe(false);
      expect(closed.error).toMatch(/cell7\.py/);
      const noResolver = await applyEdit({ ops: [{ kind: "edit", uri: CELL0, range: range(0, 0, 0, 0), newText: "x" }], save: true });
      expect(noResolver.applied).toBe(false);

      expect(applied).toHaveLength(0);
      expect(opened).toEqual([]);
    });
  });
});
