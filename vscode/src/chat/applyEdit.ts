import * as vscode from "vscode";

/** Wire types of the core→client `workspace/applyEdit` request (core/src/protocol.rs). */
export interface WireRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export type EditOp = { kind: "edit"; uri: string; range: WireRange; newText: string } | { kind: "create"; uri: string; content: string };

export interface ApplyEditParams {
  ops: EditOp[];
  save: boolean;
}

export interface ApplyEditResult {
  applied: boolean;
  error?: string;
}

/** Resolves the core's virtual notebook-cell URI to the open cell (DocumentSync.cellForUri). */
export type CellResolver = (virtualUri: string) => { document: vscode.TextDocument; notebook: vscode.NotebookDocument } | undefined;

export interface ApplyEditOptions {
  resolveCell?: CellResolver;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `<nb>.ipynb.cells.<ext>`: the read-only concatenation of a notebook's code cells. */
const CONCAT_PATH = /\.ipynb\.cells\.[^./\\]+$/;
/** `<nb>.ipynb.cell<i>.<ext>`: one code cell, synced under a virtual file path. */
const CELL_PATH = /\.ipynb\.cell\d+\.[^./\\]+$/;

function toRange(r: WireRange): vscode.Range {
  return new vscode.Range(new vscode.Position(r.start.line, r.start.character), new vscode.Position(r.end.line, r.end.character));
}

/**
 * Applies an approved agent edit as one `WorkspaceEdit` (one undo step).
 * Files to edit are opened first (in the background if they are not shown);
 * files to create must not exist. Notebook cells arrive under their virtual
 * `<nb>.ipynb.cell<i>.<ext>` URI and are edited in the open cell document
 * (`resolveCell`); the concatenated `.cells.<ext>` doc and new cells are refused.
 * With `save`, every touched file (or a cell's notebook), and only those, is
 * saved afterwards. Never throws: failures come back as `error`.
 */
export async function applyEdit(params: ApplyEditParams, opts: ApplyEditOptions = {}): Promise<ApplyEditResult> {
  let edit: vscode.WorkspaceEdit;
  const touched = new Map<string, vscode.Uri>();
  const notebooks = new Map<string, vscode.NotebookDocument>();
  try {
    edit = new vscode.WorkspaceEdit();
    for (const op of params.ops) {
      const uri = vscode.Uri.parse(op.uri, true);
      if (CONCAT_PATH.test(uri.path)) {
        return { applied: false, error: `${op.uri} is the read-only view of a notebook's cells; edit a single cell (.cell<N>) instead` };
      }
      if (CELL_PATH.test(uri.path)) {
        if (op.kind === "create") return { applied: false, error: `LocalPilot can't create notebook cells (${op.uri})` };
        const cell = opts.resolveCell?.(op.uri);
        if (!cell) return { applied: false, error: `cannot edit ${op.uri}: that notebook cell is not open` };
        if (op.kind !== "edit") return { applied: false, error: `unknown edit op ${JSON.stringify((op as { kind?: unknown }).kind)}` };
        notebooks.set(cell.notebook.uri.toString(), cell.notebook);
        edit.replace(cell.document.uri, toRange(op.range), op.newText);
        continue;
      }
      touched.set(uri.toString(), uri);
      if (op.kind === "edit") {
        try {
          await vscode.workspace.openTextDocument(uri);
        } catch (e) {
          return { applied: false, error: `cannot open ${op.uri}: ${message(e)}` };
        }
        edit.replace(uri, toRange(op.range), op.newText);
      } else if (op.kind === "create") {
        edit.createFile(uri, { contents: Buffer.from(op.content, "utf8") });
      } else {
        return { applied: false, error: `unknown edit op ${JSON.stringify((op as { kind?: unknown }).kind)}` };
      }
    }
  } catch (e) {
    return { applied: false, error: `invalid edit: ${message(e)}` };
  }

  try {
    if (!(await vscode.workspace.applyEdit(edit))) {
      return { applied: false, error: `VS Code could not apply the edit to ${[...touched.keys(), ...notebooks.keys()].join(", ")}` };
    }
  } catch (e) {
    return { applied: false, error: `applying the edit failed: ${message(e)}` };
  }
  if (!params.save) return { applied: true };

  const unsaved: string[] = [];
  for (const [key, uri] of touched) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      // save() resolves false both on failure and for a clean document, so judge by isDirty.
      await doc.save();
      if (doc.isDirty) unsaved.push(key);
    } catch (e) {
      unsaved.push(`${key} (${message(e)})`);
    }
  }
  // Cells are saved through their notebook (once per notebook).
  for (const [key, nb] of notebooks) {
    try {
      await nb.save();
      if (nb.isDirty) unsaved.push(key);
    } catch (e) {
      unsaved.push(`${key} (${message(e)})`);
    }
  }
  return unsaved.length ? { applied: true, error: `applied but could not save ${unsaved.join(", ")}` } : { applied: true };
}
