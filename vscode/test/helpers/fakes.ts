// Shared fakes for the document-sync and inline-provider unit tests.
import type * as vscode from "vscode";
import type { CoreState } from "../../src/rpc/coreClient";
import { EventEmitter, NotebookCellKind, Position, Range, Uri, workspace } from "../mocks/vscode";

export const ROOT = "/work/proj";

export interface Call {
  kind: "notify" | "request";
  method: string;
  params: unknown;
}

/** Records every notify/request in order; answers completion/request like fakeCore.mjs. */
export class FakeClient {
  readonly calls: Call[] = [];
  readonly states = new EventEmitter<CoreState>();
  readonly onDidChangeState = this.states.event;
  /** Override to control `request` results; the default mirrors fakeCore's `fake()` item. */
  respond: (method: string, params: unknown) => Promise<unknown> = async (_method, params) => {
    const { position } = params as { position: { line: number; character: number } };
    return { items: [{ text: "fake()", range: { start: position, end: position } }] };
  };

  notify(method: string, params?: unknown): void {
    this.calls.push({ kind: "notify", method, params });
  }

  request<T>(method: string, params?: unknown, token?: vscode.CancellationToken): Promise<T> {
    this.calls.push({ kind: "request", method, params });
    const result = this.respond(method, params) as Promise<T>;
    if (!token) return result;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (token.isCancellationRequested) return abort();
      token.onCancellationRequested(abort);
      result.then(resolve, reject);
    });
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  of(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }
}

export interface FakeDoc {
  uri: Uri;
  languageId: string;
  version: number;
  text: string;
  getText(): string;
}

export function fakeDoc(uri: Uri | string, text = "", languageId = "typescript"): FakeDoc {
  const doc: FakeDoc = {
    uri: typeof uri === "string" ? Uri.file(uri) : uri,
    languageId,
    version: 1,
    text,
    getText: () => doc.text,
  };
  return doc;
}

export function asDoc(doc: FakeDoc): vscode.TextDocument {
  return doc as unknown as vscode.TextDocument;
}

export interface FakeCellSpec {
  kind: "code" | "markdown";
  text: string;
  languageId?: string;
}

export interface FakeNotebook {
  uri: Uri;
  notebookType: string;
  cells: Array<{ index: number; kind: NotebookCellKind; document: FakeDoc }>;
  getCells(): FakeNotebook["cells"];
}

export function fakeNotebook(path: string, specs: FakeCellSpec[]): FakeNotebook {
  const nb: FakeNotebook = {
    uri: Uri.file(path),
    notebookType: "jupyter-notebook",
    cells: specs.map((s, index) => ({
      index,
      kind: s.kind === "code" ? NotebookCellKind.Code : NotebookCellKind.Markup,
      document: fakeDoc(
        Uri.from({ scheme: "vscode-notebook-cell", path, fragment: `W${index}sZmlsZQ==` }),
        s.text,
        s.kind === "code" ? (s.languageId ?? "python") : "markdown",
      ),
    })),
    getCells: () => nb.cells,
  };
  return nb;
}

/** A text change event for `doc` (bumps its version and replaces its text). */
export function changeEvent(doc: FakeDoc, newText: string, range: Range, text: string) {
  doc.version += 1;
  doc.text = newText;
  return { document: doc, contentChanges: [{ range, rangeOffset: 0, rangeLength: 0, text }], reason: undefined };
}

export function pos(line: number, character: number): vscode.Position {
  return new Position(line, character) as unknown as vscode.Position;
}

export function range(l1: number, c1: number, l2: number, c2: number): Range {
  return new Range(new Position(l1, c1), new Position(l2, c2));
}

export function resetWorkspace(folders: string[] = [ROOT]): void {
  workspace.workspaceFolders = folders.map((p, index) => ({ uri: Uri.file(p), name: p, index }));
  workspace.textDocuments = [];
  workspace.notebookDocuments = [];
}

/** A cancellation token the test cancels by hand. */
export function tokenSource() {
  const emitter = new EventEmitter<void>();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: emitter.event,
  };
  return {
    token: token as unknown as vscode.CancellationToken,
    cancel() {
      token.isCancellationRequested = true;
      emitter.fire();
    },
  };
}
