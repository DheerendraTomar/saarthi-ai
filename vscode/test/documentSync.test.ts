import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSync, isSyncable, toContentChanges } from "../src/documentSync";
import { InlineProvider } from "../src/inlineProvider";
import { isNotebookCell, notebookCellUri } from "../src/notebookUris";
import { DEFAULT_SETTINGS } from "../src/settings";
import { events, Uri, workspace } from "./mocks/vscode";
import {
  asDoc,
  changeEvent,
  FakeClient,
  fakeDoc,
  fakeNotebook,
  pos,
  range,
  resetWorkspace,
  ROOT,
  tokenSource,
} from "./helpers/fakes";

const syncs: DocumentSync[] = [];
function makeSync(client: FakeClient, root = ROOT): DocumentSync {
  const sync = new DocumentSync(client, root);
  syncs.push(sync);
  return sync;
}

beforeEach(() => resetWorkspace());
afterEach(() => {
  for (const s of syncs.splice(0)) s.dispose();
  vi.useRealTimers();
});

describe("DocumentSync", () => {
  it("only_file_scheme_under_root_is_syncable", () => {
    resetWorkspace([ROOT, "/work/other"]);
    expect(isSyncable(asDoc(fakeDoc(`${ROOT}/src/a.ts`)), ROOT)).toBe(true);
    expect(isSyncable(asDoc(fakeDoc(Uri.from({ scheme: "untitled", path: "Untitled-1" }))), ROOT)).toBe(false);
    expect(isSyncable(asDoc(fakeDoc(Uri.from({ scheme: "git", path: `${ROOT}/src/a.ts` }))), ROOT)).toBe(false);
    expect(isSyncable(asDoc(fakeDoc(Uri.from({ scheme: "output", path: "extension-output-1" }))), ROOT)).toBe(false);
    // Second workspace folder, a sibling with a shared prefix, and the parent are all outside the root.
    expect(isSyncable(asDoc(fakeDoc("/work/other/b.ts")), ROOT)).toBe(false);
    expect(isSyncable(asDoc(fakeDoc("/work/proj-2/b.ts")), ROOT)).toBe(false);
    expect(isSyncable(asDoc(fakeDoc("/work/b.ts")), ROOT)).toBe(false);

    // Only the syncable ones reach the core.
    const client = new FakeClient();
    makeSync(client);
    for (const d of [
      fakeDoc(Uri.from({ scheme: "untitled", path: "Untitled-1" })),
      fakeDoc(Uri.from({ scheme: "output", path: "extension-output-1" })),
      fakeDoc("/work/other/b.ts"),
      fakeDoc(`${ROOT}/src/a.ts`, "x"),
    ]) {
      events.openText.fire(d);
    }
    expect(client.of("textDocument/didOpen")).toEqual([
      { uri: `file://${ROOT}/src/a.ts`, languageId: "typescript", version: 1, text: "x" },
    ]);
  });

  it("notebook_cells_map_to_virtual_file_uris_and_concat_doc", async () => {
    vi.useFakeTimers();
    const nbPath = `${ROOT}/analysis.ipynb`;
    const nb = fakeNotebook(nbPath, [
      { kind: "code", text: "import os" },
      { kind: "markdown", text: "# Notes" },
      { kind: "code", text: "x = 1" },
    ]);
    const [code0, md1, code2] = nb.cells.map((c) => c.document);
    const client = new FakeClient();
    makeSync(client);
    // VS Code opens the cell documents, then the notebook.
    for (const c of nb.cells) {
      workspace.textDocuments.push(c.document);
      events.openText.fire(c.document);
    }
    workspace.notebookDocuments.push(nb);
    events.openNotebook.fire(nb);

    const cell0 = `file://${nbPath}.cell0.py`;
    const cell2 = `file://${nbPath}.cell2.py`;
    const concat = `file://${nbPath}.cells.py`;
    expect(isNotebookCell(asDoc(code0))).toBe(true);
    expect(isNotebookCell(asDoc(fakeDoc(`${ROOT}/a.py`)))).toBe(false);
    expect(notebookCellUri(asDoc(code0))).toBe(cell0);
    expect(notebookCellUri(asDoc(code2))).toBe(cell2);
    expect(notebookCellUri(asDoc(md1))).toBeUndefined();
    expect(isSyncable(asDoc(md1), ROOT)).toBe(false);
    expect(client.of("textDocument/didOpen")).toEqual([
      { uri: cell0, languageId: "python", version: 1, text: "import os" },
      { uri: cell2, languageId: "python", version: 1, text: "x = 1" },
      { uri: concat, languageId: "python", version: 1, text: "import os\n\nx = 1" },
    ]);

    // Two keystrokes in cell 2: per-cell didChange immediately, one debounced concat update.
    events.changeText.fire(changeEvent(code2, "x = 12", range(0, 5, 0, 5), "2"));
    events.changeText.fire(changeEvent(code2, "x = 123", range(0, 6, 0, 6), "3"));
    expect(client.of("textDocument/didChange")).toEqual([
      { uri: cell2, version: 2, contentChanges: [{ range: range(0, 5, 0, 5), text: "2" }] },
      { uri: cell2, version: 3, contentChanges: [{ range: range(0, 6, 0, 6), text: "3" }] },
    ]);
    await vi.advanceTimersByTimeAsync(199);
    expect(client.of("textDocument/didChange")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.of("textDocument/didChange").slice(2)).toEqual([
      { uri: concat, version: 2, contentChanges: [{ text: "import os\n\nx = 123" }] },
    ]);

    // Completions: code cells use the virtual URI; markdown cells are never completed.
    const provider = new InlineProvider(client, DEFAULT_SETTINGS);
    const md = provider.provideInlineCompletionItems(asDoc(md1), pos(0, 7), {} as never, tokenSource().token);
    await vi.advanceTimersByTimeAsync(500);
    expect(await md).toEqual([]);
    expect(client.of("completion/request")).toEqual([]);
    const items = provider.provideInlineCompletionItems(asDoc(code2), pos(0, 7), {} as never, tokenSource().token);
    await vi.advanceTimersByTimeAsync(DEFAULT_SETTINGS.completionDebounceMs);
    expect(await items).toHaveLength(1);
    expect(client.of("completion/request")).toEqual([{ uri: cell2, position: { line: 0, character: 7 }, requestId: "1" }]);

    // Closing the notebook closes every virtual document, and nothing fires afterwards.
    events.changeText.fire(changeEvent(code0, "import sys", range(0, 7, 0, 9), "sys"));
    workspace.notebookDocuments.splice(0);
    events.closeNotebook.fire(nb);
    expect(client.of("textDocument/didClose")).toEqual([{ uri: cell0 }, { uri: cell2 }, { uri: concat }]);
    const before = client.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.calls.length).toBe(before);
  });

  it("content_changes_map_ranges_and_text", () => {
    const r1 = range(1, 2, 1, 4);
    const r2 = range(0, 0, 0, 0);
    expect(
      toContentChanges({
        contentChanges: [
          { range: r1, rangeOffset: 10, rangeLength: 2, text: "é😀" },
          { range: r2, rangeOffset: 0, rangeLength: 0, text: "" },
        ],
      } as never),
    ).toEqual([
      { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } }, text: "é😀" },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "" },
    ]);

    // Open → change → save → close for a regular file, with versions forwarded.
    const client = new FakeClient();
    makeSync(client);
    const doc = fakeDoc(`${ROOT}/a.ts`, "ab");
    events.openText.fire(doc);
    events.changeText.fire(changeEvent(doc, "aXb", range(0, 1, 0, 1), "X"));
    events.changeText.fire({ document: doc, contentChanges: [], reason: undefined }); // dirty-state only
    events.saveText.fire(doc);
    events.closeText.fire(doc);
    const uri = `file://${ROOT}/a.ts`;
    expect(client.calls.map((c) => [c.method, c.params])).toEqual([
      ["textDocument/didOpen", { uri, languageId: "typescript", version: 1, text: "ab" }],
      ["textDocument/didChange", { uri, version: 2, contentChanges: [{ range: range(0, 1, 0, 1), text: "X" }] }],
      ["textDocument/didSave", { uri }],
      ["textDocument/didClose", { uri }],
    ]);
  });

  it("open_documents_are_resent_after_restart", () => {
    const a = fakeDoc(`${ROOT}/a.ts`, "a");
    const outside = fakeDoc("/elsewhere/b.ts", "b");
    workspace.textDocuments.push(a, outside);
    const nb = fakeNotebook(`${ROOT}/n.ipynb`, [{ kind: "code", text: "1+1" }]);
    workspace.textDocuments.push(nb.cells[0].document);
    workspace.notebookDocuments.push(nb);
    const client = new FakeClient();
    makeSync(client);
    const opened = () => (client.of("textDocument/didOpen") as Array<{ uri: string }>).map((p) => p.uri);
    const expected = [`file://${ROOT}/a.ts`, `file://${ROOT}/n.ipynb.cell0.py`, `file://${ROOT}/n.ipynb.cells.py`];
    expect(opened()).toEqual(expected);

    // Edited while running; the restarted core gets the current text and version.
    events.changeText.fire(changeEvent(a, "ab", range(0, 1, 0, 1), "b"));
    client.calls.length = 0;
    client.states.fire("crashed");
    client.states.fire("ready");
    expect(opened()).toEqual([]);
    client.states.fire("starting");
    expect(opened()).toEqual(expected);
    expect(client.of("textDocument/didOpen")[0]).toEqual({
      uri: `file://${ROOT}/a.ts`,
      languageId: "typescript",
      version: 2,
      text: "ab",
    });
    expect(client.of("textDocument/didClose")).toEqual([]);
  });
});
