import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSync } from "../src/documentSync";
import { ACCEPT_COMMAND, Debouncer, InlineProvider } from "../src/inlineProvider";
import { DEFAULT_SETTINGS, type Settings } from "../src/settings";
import { events, Uri } from "./mocks/vscode";
import { asDoc, changeEvent, FakeClient, fakeDoc, pos, range, resetWorkspace, ROOT, tokenSource } from "./helpers/fakes";

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });
const ctx = {} as never;
const URI = `file://${ROOT}/a.ts`;

/** Tracks whether a promise has settled, so fake-timer tests can assert "not yet". */
function track<T>(p: Promise<T>) {
  const t = { settled: false, value: undefined as T | undefined };
  p.then((v) => {
    t.settled = true;
    t.value = v;
  });
  return t;
}

beforeEach(() => {
  resetWorkspace();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("Debouncer", () => {
  it("debouncer_fires_once_after_quiet_period_and_cancels_previous", async () => {
    const d = new Debouncer(120);
    const first = track(d.wait());
    await vi.advanceTimersByTimeAsync(50);
    const second = track(d.wait());
    await vi.advanceTimersByTimeAsync(50);
    const third = track(d.wait());
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toEqual({ settled: true, value: false });
    expect(second).toEqual({ settled: true, value: false });
    await vi.advanceTimersByTimeAsync(119);
    expect(third.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(third).toEqual({ settled: true, value: true });

    // A cancelled token or cancel() settles the waiter with false; nothing fires later.
    const src = tokenSource();
    const viaToken = track(d.wait(src.token));
    src.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(viaToken).toEqual({ settled: true, value: false });
    const viaCancel = track(d.wait());
    d.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(viaCancel).toEqual({ settled: true, value: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("InlineProvider", () => {
  it("provider_cancels_inflight_on_token_cancel", async () => {
    const client = new FakeClient();
    client.respond = () => new Promise(() => {}); // the core never answers
    const provider = new InlineProvider(client, settings());
    const doc = asDoc(fakeDoc(`${ROOT}/a.ts`));

    // Cancelled while still debouncing: no request at all.
    const early = tokenSource();
    const r0 = provider.provideInlineCompletionItems(doc, pos(0, 1), ctx, early.token);
    early.cancel();
    expect(await r0).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.calls).toEqual([]);

    // Cancelled while in flight: completion/cancel with the same requestId.
    const src = tokenSource();
    const r1 = provider.provideInlineCompletionItems(doc, pos(0, 1), ctx, src.token);
    await vi.advanceTimersByTimeAsync(120);
    expect(client.of("completion/request")).toEqual([{ uri: URI, position: { line: 0, character: 1 }, requestId: "1" }]);
    src.cancel();
    expect(await r1).toEqual([]);
    expect(client.of("completion/cancel")).toEqual([{ requestId: "1" }]);

    // A newer call supersedes an in-flight one (even if VS Code has not cancelled its token).
    const r2 = provider.provideInlineCompletionItems(doc, pos(0, 2), ctx, tokenSource().token);
    await vi.advanceTimersByTimeAsync(120);
    const r3 = provider.provideInlineCompletionItems(doc, pos(0, 3), ctx, tokenSource().token);
    expect(client.of("completion/cancel")).toEqual([{ requestId: "1" }, { requestId: "2" }]);
    expect(await r2).toEqual([]);
    await vi.advanceTimersByTimeAsync(120);
    expect(client.of("completion/request")).toHaveLength(3);
    void r3;
  });

  it("provider_returns_empty_when_disabled", async () => {
    const client = new FakeClient();
    const provider = new InlineProvider(client, settings({ completionsEnabled: false }));
    const doc = asDoc(fakeDoc(`${ROOT}/a.ts`));
    const r = provider.provideInlineCompletionItems(doc, pos(0, 0), ctx, tokenSource().token);
    await vi.advanceTimersByTimeAsync(500);
    expect(await r).toEqual([]);

    // Unsyncable documents are skipped even when enabled.
    provider.updateSettings(settings());
    for (const d of [fakeDoc(Uri.from({ scheme: "untitled", path: "Untitled-1" })), fakeDoc("/elsewhere/b.ts")]) {
      const p = provider.provideInlineCompletionItems(asDoc(d), pos(0, 0), ctx, tokenSource().token);
      await vi.advanceTimersByTimeAsync(500);
      expect(await p).toEqual([]);
    }
    expect(client.calls).toEqual([]);

    // Re-enabled + syncable → a request goes out, debounced by completionDebounceMs.
    provider.updateSettings(settings({ completionDebounceMs: 300 }));
    const ok = track(provider.provideInlineCompletionItems(doc, pos(0, 0), ctx, tokenSource().token));
    await vi.advanceTimersByTimeAsync(299);
    expect(client.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ok.settled).toBe(true);
    expect(client.methods()).toEqual(["completion/request"]);
  });

  it("didChange_precedes_completion_request_for_same_keystroke", async () => {
    const client = new FakeClient();
    const sync = new DocumentSync(client, ROOT);
    const provider = new InlineProvider(client, settings());
    const doc = fakeDoc(`${ROOT}/a.ts`, "fo");
    events.openText.fire(doc);

    // VS Code fires the change event, then invokes the provider for the same keystroke.
    events.changeText.fire(changeEvent(doc, "foo", range(0, 2, 0, 2), "o"));
    // Synchronous: recorded before the event handler returned, with no await in between.
    expect(client.methods()).toEqual(["textDocument/didOpen", "textDocument/didChange"]);
    const items = provider.provideInlineCompletionItems(asDoc(doc), pos(0, 3), ctx, tokenSource().token);
    await vi.advanceTimersByTimeAsync(120);
    await items;
    expect(client.methods()).toEqual(["textDocument/didOpen", "textDocument/didChange", "completion/request"]);
    const [, change, request] = client.calls.map((c) => c.params as { uri: string });
    expect(change.uri).toBe(URI);
    expect(request.uri).toBe(URI);
    sync.dispose();
  });

  it("accept_reports_accepted_and_superseded_reports_rejected", async () => {
    const client = new FakeClient();
    const provider = new InlineProvider(client, settings());
    const doc = asDoc(fakeDoc(`${ROOT}/a.ts`));
    const ask = async (character: number) => {
      const p = provider.provideInlineCompletionItems(doc, pos(0, character), ctx, tokenSource().token);
      await vi.advanceTimersByTimeAsync(120);
      return p;
    };

    const first = await ask(4);
    expect(first).toEqual([
      {
        insertText: "fake()",
        range: range(0, 4, 0, 4),
        command: { command: ACCEPT_COMMAND, title: "LocalPilot: completion accepted", arguments: ["1"] },
      },
    ]);
    expect(ACCEPT_COMMAND).toBe("localpilot.completionAccepted");
    provider.reportAccepted("1");
    expect(client.of("completion/accepted")).toEqual([{ requestId: "1" }]);

    // Accepted items are not rejected later; an unaccepted one is rejected when superseded.
    await ask(10);
    expect(client.of("completion/rejected")).toEqual([]);
    await ask(11);
    expect(client.of("completion/rejected")).toEqual([{ requestId: "2" }]);

    // Empty results are never reported as rejected.
    client.respond = async () => ({ items: [] });
    expect(await ask(12)).toEqual([]);
    expect(client.of("completion/rejected")).toEqual([{ requestId: "2" }, { requestId: "3" }]);
    await ask(13);
    expect(client.of("completion/rejected")).toEqual([{ requestId: "2" }, { requestId: "3" }]);
    expect(client.of("completion/cancel")).toEqual([]);
  });

  it("partial_accept_reports_partial", async () => {
    const client = new FakeClient();
    let suggestion = "compute(value) + 1";
    client.respond = async (_m, params) => {
      const { position } = params as { position: { line: number; character: number } };
      return { items: [{ text: suggestion, range: { start: position, end: position } }] };
    };
    const provider = new InlineProvider(client, settings());
    const fdoc = fakeDoc(`${ROOT}/a.ts`, "x = \nnext");
    const ask = async (line: number, character: number) => {
      const p = provider.provideInlineCompletionItems(asDoc(fdoc), pos(line, character), ctx, tokenSource().token);
      await vi.advanceTimersByTimeAsync(120);
      return p;
    };
    const change = (newText: string, r: ReturnType<typeof range>, text: string) =>
      provider.onDidChangeTextDocument(changeEvent(fdoc, newText, r, text) as never);

    // Shown at (0,4); VS Code's "accept next word" inserts "compute" in one edit, then asks again.
    await ask(0, 4);
    change("x = compute\nnext", range(0, 4, 0, 4), "compute");
    suggestion = "(value) + 1";
    await ask(0, 11);
    expect(client.of("completion/rejected")).toEqual([]); // the partly accepted one is not rejected
    expect(client.of("completion/outcome")).toEqual([]);
    // The user stops there and types something else: reported as partial with what was taken.
    change("x = computeZ\nnext", range(0, 11, 0, 11), "Z");
    expect(client.of("completion/outcome")).toEqual([{ requestId: "1", outcome: "partial", acceptedText: "compute" }]);

    // Two partial accepts then 2 s of quiet: partial with both chunks, reported by the timer.
    fdoc.text = "y = \nnext";
    suggestion = "total(a, b)";
    await ask(0, 4); // supersedes #2 (untouched → rejected)
    expect(client.of("completion/rejected")).toEqual([{ requestId: "2" }]);
    change("y = total\nnext", range(0, 4, 0, 4), "total");
    change("y = total(a,\nnext", range(0, 9, 0, 9), "(a,");
    await vi.advanceTimersByTimeAsync(1999);
    expect(client.of("completion/outcome")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.of("completion/outcome")[1]).toEqual({ requestId: "3", outcome: "partial", acceptedText: "total(a," });

    // A full accept (Tab) inserts everything in one edit and runs the command: accepted only, once.
    fdoc.text = "z = \nnext";
    suggestion = "go()";
    await ask(0, 4);
    change("z = go()\nnext", range(0, 4, 0, 4), "go()");
    provider.reportAccepted("4");
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.of("completion/accepted")).toEqual([{ requestId: "4" }]);
    expect(client.of("completion/outcome")).toHaveLength(2);

    // Only punctuation gained (an auto-closed bracket), then something else: rejected.
    fdoc.text = "w = \nnext";
    suggestion = "(), 1";
    await ask(0, 4);
    change("w = ()\nnext", range(0, 4, 0, 4), "()");
    change("w = ()\nnextQ", range(1, 4, 1, 4), "Q");
    expect(client.of("completion/rejected")).toEqual([{ requestId: "2" }, { requestId: "5" }]);
    expect(client.of("completion/outcome")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("typed_through_reports_typedThrough", async () => {
    const client = new FakeClient();
    const full = "foo(1)";
    client.respond = async (_m, params) => {
      const { position } = params as { position: { line: number; character: number } };
      return { items: [{ text: full.slice(position.character - 4), range: { start: position, end: position } }] };
    };
    const provider = new InlineProvider(client, settings());
    const fdoc = fakeDoc(`${ROOT}/a.ts`, "x = ");
    const ask = async (character: number) => {
      const p = provider.provideInlineCompletionItems(asDoc(fdoc), pos(0, character), ctx, tokenSource().token);
      await vi.advanceTimersByTimeAsync(120);
      return p;
    };

    // The user types the suggestion one key at a time; VS Code asks again after each key.
    await ask(4);
    let text = "x = ";
    for (const ch of full) {
      provider.onDidChangeTextDocument(changeEvent(fdoc, (text += ch), range(0, text.length - 1, 0, text.length - 1), ch) as never);
      await ask(text.length);
    }
    await vi.advanceTimersByTimeAsync(2000);
    const outcomes = client.of("completion/outcome") as Array<{ requestId: string; outcome: string }>;
    expect(outcomes.find((o) => o.requestId === "1")).toEqual({ requestId: "1", outcome: "typedThrough" });
    expect(client.of("completion/rejected")).not.toContainEqual({ requestId: "1" });
    expect(client.of("completion/accepted")).toEqual([]);

    // Typing only part of a word, then something else: rejected (no word was gained).
    const before = (client.of("completion/rejected") as unknown[]).length;
    fdoc.text = "y = ";
    await ask(4); // #8 shown: "foo(1)"
    provider.onDidChangeTextDocument(changeEvent(fdoc, "y = f", range(0, 4, 0, 4), "f") as never);
    provider.onDidChangeTextDocument(changeEvent(fdoc, "y = fx", range(0, 5, 0, 5), "x") as never);
    expect((client.of("completion/rejected") as unknown[]).slice(before)).toContainEqual({ requestId: "8" });
    expect((client.of("completion/outcome") as Array<{ requestId: string }>).filter((o) => o.requestId === "8")).toEqual([]);

    // A suggestion ending in a newline: typing its text and then Enter (auto-indented) is still typed through.
    client.respond = async (_m, params) => {
      const { position } = params as { position: { line: number; character: number } };
      return { items: [{ text: "go()\n", range: { start: position, end: position } }] };
    };
    fdoc.text = "z = ";
    await ask(4); // #9
    let typed = "z = ";
    for (const ch of "go()") provider.onDidChangeTextDocument(changeEvent(fdoc, (typed += ch), range(0, typed.length - 1, 0, typed.length - 1), ch) as never);
    provider.onDidChangeTextDocument(changeEvent(fdoc, typed + "\n    ", range(0, typed.length, 0, typed.length), "\n    ") as never);
    expect(client.of("completion/outcome")).toContainEqual({ requestId: "9", outcome: "typedThrough" });
  });
});
