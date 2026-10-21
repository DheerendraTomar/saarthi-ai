import * as vscode from "vscode";

/**
 * Notebook cells as virtual files. The core keys its overlay by file path, so
 * each code cell of `<nb>.ipynb` is synced as `file://<nb>.ipynb.cell<i>.<ext>`
 * (`i` = the cell's index in the notebook), plus one `file://<nb>.ipynb.cells.<ext>`
 * holding every code cell concatenated, which the core's related-snippet
 * retrieval picks up as a recently-edited sibling. Markdown cells are not synced.
 */

export const NOTEBOOK_CELL_SCHEME = "vscode-notebook-cell";

const EXT_BY_LANGUAGE: Record<string, string> = {
  python: "py",
  javascript: "js",
  typescript: "ts",
  r: "r",
  julia: "jl",
};

/** File extension of a cell's virtual document, from its language id. */
export function cellExt(languageId: string): string {
  return EXT_BY_LANGUAGE[languageId] ?? "txt";
}

export function isNotebookCell(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === NOTEBOOK_CELL_SCHEME;
}

/** A `.ipynb` file notebook (the only kind synced). */
export function isJupyterFile(nb: vscode.NotebookDocument): boolean {
  return nb.uri.scheme === "file" && nb.uri.path.endsWith(".ipynb");
}

export function virtualCellUri(nb: vscode.NotebookDocument, index: number, languageId: string): string {
  return vscode.Uri.file(`${nb.uri.fsPath}.cell${index}.${cellExt(languageId)}`).toString();
}

export function concatUri(nb: vscode.NotebookDocument, languageId: string): string {
  return vscode.Uri.file(`${nb.uri.fsPath}.cells.${cellExt(languageId)}`).toString();
}

/** The open notebook that owns `cellDoc`, and the cell itself. */
export function findCell(cellDoc: vscode.TextDocument): { nb: vscode.NotebookDocument; cell: vscode.NotebookCell } | undefined {
  if (!isNotebookCell(cellDoc)) return undefined;
  const key = cellDoc.uri.toString();
  for (const nb of vscode.workspace.notebookDocuments) {
    if (nb.uri.path !== cellDoc.uri.path) continue;
    const cell = nb.getCells().find((c) => c.document.uri.toString() === key);
    if (cell) return { nb, cell };
  }
  return undefined;
}

/** Virtual `file:` URI of a code cell of a `.ipynb`; undefined for markdown cells and anything else. */
export function notebookCellUri(cellDoc: vscode.TextDocument): string | undefined {
  const found = findCell(cellDoc);
  if (!found || found.cell.kind !== vscode.NotebookCellKind.Code || !isJupyterFile(found.nb)) return undefined;
  return virtualCellUri(found.nb, found.cell.index, found.cell.document.languageId);
}
