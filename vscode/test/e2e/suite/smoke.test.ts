// End-to-end smoke test inside a real VS Code, against test/fakeCore.mjs.
/// <reference types="mocha" />
import * as assert from "node:assert/strict";
import { join } from "node:path";
import * as vscode from "vscode";
import type { LocalPilotApi } from "../../../src/extension";

const EXTENSION_ID = "localpilot.localpilot";

describe("LocalPilot e2e smoke", () => {
  let api: LocalPilotApi;

  before(async () => {
    const ext = vscode.extensions.getExtension<LocalPilotApi | undefined>(EXTENSION_ID);
    assert.ok(ext, `${EXTENSION_ID} is not installed in the test host`);
    const exported = await ext.activate();
    assert.ok(ext.isActive, "extension did not activate");
    assert.ok(exported, "activate() returned no API (is a workspace folder open?)");
    api = exported;
    await api.ready;
  });

  it("activates and starts the (fake) core", () => {
    assert.equal(process.env.LOCALPILOT_FAKE_CORE, "1");
    assert.equal(api.client.state, "ready");
  });

  it("returns the core's completion as an inline item for a.py", async () => {
    const root = process.env.LOCALPILOT_E2E_WORKSPACE;
    assert.ok(root, "LOCALPILOT_E2E_WORKSPACE is not set");
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, "a.py")));
    await vscode.window.showTextDocument(doc);
    const position = new vscode.Position(1, 4);

    // VS Code 1.142 has no `vscode.executeInlineCompletionProvider` command, so call the
    // provider the extension registered (exported on its API) the way the editor does.
    const tokens = new vscode.CancellationTokenSource();
    const items = await api.inline.provideInlineCompletionItems(
      doc,
      position,
      { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
      tokens.token,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].insertText, "fake()");
    assert.ok(items[0].range?.start.isEqual(position), "item range starts at the cursor");
    assert.equal(items[0].command?.command, "localpilot.completionAccepted");
  });

  it("opens the chat view", async () => {
    await vscode.commands.executeCommand("localpilot.openChat");
    // The command focuses the view; VS Code then resolves the webview through our provider.
    // `view` is private on ChatViewProvider — read here only to prove the webview really opened.
    const resolved = () => (api.chatView as unknown as { view?: vscode.WebviewView }).view;
    for (let i = 0; i < 100 && !resolved(); i++) await new Promise((r) => setTimeout(r, 100));
    const view = resolved();
    assert.ok(view, "chat webview was not resolved within 10s");
    assert.match(view.webview.html, /<html/i, "chat webview has no HTML");
  });
});
