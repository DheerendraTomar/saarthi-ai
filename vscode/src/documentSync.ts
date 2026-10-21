import * as path from "node:path";
import * as vscode from "vscode";
import type { CoreClient } from "./rpc/coreClient";
import { concatUri, findCell, isJupyterFile, isNotebookCell, notebookCellUri, virtualCellUri } from "./notebookUris";

/** The part of `CoreClient` that document sync uses (a fake in tests). */
export type SyncClient = Pick<CoreClient, "notify" | "onDidChangeState">;

/** Quiet period before the notebook's concatenated `.cells.<ext>` document is re-sent. */
export const CONCAT_DEBOUNCE_MS = 200;

export interface WirePosition {
  line: number;
  character: number;
}
export interface WireRange {
  start: WirePosition;
  end: WirePosition;
}
/** `range` omitted = replace the whole document. */
export interface WireContentChange {
  range?: WireRange;
  text: string;
}

/** True when `p` is strictly inside `root` (a sibling such as `<root>-2` is outside). */
export function isUnder(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The URI the core knows `doc` by, or undefined if it is not synced: `file:`
 * documents under `root` keep their own URI; code cells of a `.ipynb` under
 * `root` map to their virtual `file://<nb>.cell<i>.<ext>` URI.
 */
export function syncUri(doc: vscode.TextDocument, root: string): string | undefined {
  if (doc.uri.scheme === "file") return isUnder(root, doc.uri.fsPath) ? doc.uri.toString() : undefined;
  if (isNotebookCell(doc) && isUnder(root, doc.uri.fsPath)) return notebookCellUri(doc);
  return undefined;
}

export function isSyncable(doc: vscode.TextDocument, root: string): boolean {
  return syncUri(doc, root) !== undefined;
}

/** VS Code positions are already UTF-16 `{ line, character }`, the core's unit: no conversion. */
export function toContentChanges(e: Pick<vscode.TextDocumentChangeEvent, "contentChanges">): WireContentChange[] {
  return e.contentChanges.map((c) => ({
    range: {
      start: { line: c.range.start.line, character: c.range.start.character },
      end: { line: c.range.end.line, character: c.range.end.character },
    },
    text: c.text,
  }));
}

interface NotebookState {
  nb: vscode.NotebookDocument;
  /** Cell document URI → virtual cell URI sent to the core. */
  cells: Map<string, string>;
  concat?: { uri: string; version: number };
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Mirrors open editors into the core's overlay (`textDocument/didOpen|didChange|didClose|didSave`).
 * `didChange` is sent synchronously inside VS Code's change event, so it always
 * precedes the completion request VS Code makes for the same keystroke.
 * Everything is re-opened whenever the core (re)starts.
 */
export class DocumentSync implements vscode.Disposable {
  private readonly files = new Set<string>();
  private readonly notebooks = new Map<string, NotebookState>();
  private readonly cellOwner = new Map<string, NotebookState>();
  private readonly subscriptions: Array<{ dispose(): unknown }>;

  constructor(
    private readonly client: SyncClient,
    private readonly root: string,
  ) {
    const ws = vscode.workspace;
    this.subscriptions = [
      ws.onDidOpenTextDocument((d) => this.onOpen(d)),
      ws.onDidChangeTextDocument((e) => this.onChange(e)),
      ws.onDidCloseTextDocument((d) => this.onClose(d)),
      ws.onDidSaveTextDocument((d) => this.onSave(d)),
      ws.onDidOpenNotebookDocument((nb) => this.reconcile(nb)),
      ws.onDidChangeNotebookDocument((e) => {
        if (e.contentChanges.length > 0) this.reconcile(e.notebook);
      }),
      ws.onDidCloseNotebookDocument((nb) => this.closeNotebook(nb)),
      ws.onDidSaveNotebookDocument((nb) => this.onSaveNotebook(nb)),
      // The queue of a starting core is cleared before this fires, so these
      // didOpens precede any later didChange.
      client.onDidChangeState((state) => {
        if (state === "starting") this.openAll();
      }),
    ];
    this.openAll();
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    for (const st of this.notebooks.values()) clearTimeout(st.timer);
    this.notebooks.clear();
    this.cellOwner.clear();
    this.files.clear();
  }

  /**
   * The open code cell the core knows as `virtualUri` (`file://<nb>.ipynb.cell<i>.<ext>`),
   * with its notebook; undefined for anything else, including the `.cells.<ext>` concat doc.
   */
  cellForUri(virtualUri: string): { document: vscode.TextDocument; notebook: vscode.NotebookDocument } | undefined {
    let fsPath: string;
    try {
      fsPath = vscode.Uri.parse(virtualUri, true).fsPath;
    } catch {
      return undefined;
    }
    for (const st of this.notebooks.values()) {
      for (const [cellKey, virtual] of st.cells) {
        // Compare paths, not strings: the core may encode the URI differently.
        if (virtual !== virtualUri && vscode.Uri.parse(virtual).fsPath !== fsPath) continue;
        const cell = st.nb.getCells().find((c) => c.document.uri.toString() === cellKey);
        if (cell) return { document: cell.document, notebook: st.nb };
      }
    }
    return undefined;
  }

  /** The cell document behind a virtual cell URI (see `cellForUri`). */
  cellDocumentForUri(virtualUri: string): vscode.TextDocument | undefined {
    return this.cellForUri(virtualUri)?.document;
  }

  /** Sends didOpen for everything currently open (a fresh core has an empty overlay). */
  private openAll(): void {
    for (const st of this.notebooks.values()) clearTimeout(st.timer);
    this.files.clear();
    this.notebooks.clear();
    this.cellOwner.clear();
    for (const doc of vscode.workspace.textDocuments) this.onOpen(doc);
    for (const nb of vscode.workspace.notebookDocuments) this.reconcile(nb);
  }

  private onOpen(doc: vscode.TextDocument): void {
    if (doc.uri.scheme === "file") {
      const uri = doc.uri.toString();
      if (this.files.has(uri) || !isUnder(this.root, doc.uri.fsPath)) return;
      this.files.add(uri);
      this.client.notify("textDocument/didOpen", {
        uri,
        languageId: doc.languageId,
        version: doc.version,
        text: doc.getText(),
      });
    } else if (isNotebookCell(doc)) {
      // Cells normally open before their notebook (handled by onDidOpenNotebookDocument);
      // a cell reopened later (e.g. after a language change) is reconciled here.
      const found = findCell(doc);
      if (found) this.reconcile(found.nb);
    }
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) return;
    const key = e.document.uri.toString();
    if (this.files.has(key)) {
      this.client.notify("textDocument/didChange", {
        uri: key,
        version: e.document.version,
        contentChanges: toContentChanges(e),
      });
      return;
    }
    const st = this.cellOwner.get(key);
    const virtual = st?.cells.get(key);
    if (!st || !virtual) return;
    this.client.notify("textDocument/didChange", {
      uri: virtual,
      version: e.document.version,
      contentChanges: toContentChanges(e),
    });
    this.scheduleConcat(st);
  }

  private onSave(doc: vscode.TextDocument): void {
    const uri = doc.uri.toString();
    if (this.files.has(uri)) this.client.notify("textDocument/didSave", { uri });
  }

  /** A saved notebook saved its cells: tell the core about every virtual document of it. */
  private onSaveNotebook(nb: vscode.NotebookDocument): void {
    const st = this.notebooks.get(nb.uri.toString());
    if (!st) return;
    for (const virtual of st.cells.values()) this.client.notify("textDocument/didSave", { uri: virtual });
    if (st.concat) this.client.notify("textDocument/didSave", { uri: st.concat.uri });
  }

  private onClose(doc: vscode.TextDocument): void {
    // Cell documents are closed with their notebook (or re-mapped by reconcile).
    const uri = doc.uri.toString();
    if (!this.files.delete(uri)) return;
    this.client.notify("textDocument/didClose", { uri });
  }

  /** Brings the core's virtual documents for `nb` in line with its current code cells. */
  private reconcile(nb: vscode.NotebookDocument): void {
    if (!isJupyterFile(nb) || !isUnder(this.root, nb.uri.fsPath)) return;
    const key = nb.uri.toString();
    let st = this.notebooks.get(key);
    if (!st) {
      st = { nb, cells: new Map() };
      this.notebooks.set(key, st);
    }
    st.nb = nb;
    const code = nb.getCells().filter((c) => c.kind === vscode.NotebookCellKind.Code);
    const desired = new Map<string, { virtual: string; doc: vscode.TextDocument }>();
    for (const cell of code) {
      desired.set(cell.document.uri.toString(), {
        virtual: virtualCellUri(nb, cell.index, cell.document.languageId),
        doc: cell.document,
      });
    }
    let changed = false;
    for (const [cellKey, virtual] of st.cells) {
      if (desired.get(cellKey)?.virtual === virtual) continue;
      this.client.notify("textDocument/didClose", { uri: virtual });
      st.cells.delete(cellKey);
      this.cellOwner.delete(cellKey);
      changed = true;
    }
    for (const [cellKey, { virtual, doc }] of desired) {
      if (st.cells.has(cellKey)) continue;
      this.client.notify("textDocument/didOpen", {
        uri: virtual,
        languageId: doc.languageId,
        version: doc.version,
        text: doc.getText(),
      });
      st.cells.set(cellKey, virtual);
      this.cellOwner.set(cellKey, st);
      changed = true;
    }

    const wantConcat = code.length > 0 ? concatUri(nb, code[0].document.languageId) : undefined;
    if (st.concat && st.concat.uri !== wantConcat) {
      clearTimeout(st.timer);
      st.timer = undefined;
      this.client.notify("textDocument/didClose", { uri: st.concat.uri });
      st.concat = undefined;
    }
    if (wantConcat && !st.concat) {
      st.concat = { uri: wantConcat, version: 1 };
      this.client.notify("textDocument/didOpen", {
        uri: wantConcat,
        languageId: code[0].document.languageId,
        version: 1,
        text: concatText(nb),
      });
    } else if (changed) {
      this.scheduleConcat(st);
    }
  }

  private scheduleConcat(st: NotebookState): void {
    if (!st.concat) return;
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = undefined;
      if (!st.concat) return;
      st.concat.version += 1;
      this.client.notify("textDocument/didChange", {
        uri: st.concat.uri,
        version: st.concat.version,
        contentChanges: [{ text: concatText(st.nb) }],
      });
    }, CONCAT_DEBOUNCE_MS);
  }

  private closeNotebook(nb: vscode.NotebookDocument): void {
    const key = nb.uri.toString();
    const st = this.notebooks.get(key);
    if (!st) return;
    clearTimeout(st.timer);
    for (const [cellKey, virtual] of st.cells) {
      this.client.notify("textDocument/didClose", { uri: virtual });
      this.cellOwner.delete(cellKey);
    }
    if (st.concat) this.client.notify("textDocument/didClose", { uri: st.concat.uri });
    this.notebooks.delete(key);
  }
}

/** All code cells, in order, separated by a blank line. */
function concatText(nb: vscode.NotebookDocument): string {
  return nb
    .getCells()
    .filter((c) => c.kind === vscode.NotebookCellKind.Code)
    .map((c) => c.document.getText())
    .join("\n\n");
}
