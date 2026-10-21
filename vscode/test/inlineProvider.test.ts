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
    await ask(0, 4);
    // #2 was the rest of #1 (a typed-prefix hit): settled with #1's run, never reported on its own.
    expect(client.of("completion/rejected")).toEqual([]);
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
    expect(client.of("completion/rejected")).toEqual([{ requestId: "5" }]);
    expect(client.of("completion/outcome")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  /** A provider whose core always suggests `next(position)`; `type`/`edit` drive document changes. */
  function harness(initial: string, next: (character: number) => string) {
    const client = new FakeClient();
    client.respond = async (_m, params) => {
      const { position } = params as { position: { line: number; character: number } };
      return { items: [{ text: next(position.character), range: { start: position, end: position } }] };
    };
    const provider = new InlineProvider(client, settings());
    const fdoc = fakeDoc(`${ROOT}/a.ts`, initial);
    const ask = async (character: number) => {
      const p = provider.provideInlineCompletionItems(asDoc(fdoc), pos(0, character), ctx, tokenSource().token);
      await vi.advanceTimersByTimeAsync(120);
      await p;
      return String((client.of("completion/request").at(-1) as { requestId: string }).requestId);
    };
    /** Inserts `text` at `character` of line 0 in one edit (replacing `replace` characters). */
    const edit = (character: number, text: string, replace = 0) => {
      const newText = fdoc.text.slice(0, character) + text + fdoc.text.slice(character + replace);
      provider.onDidChangeTextDocument(changeEvent(fdoc, newText, range(0, character, 0, character + replace), text) as never);
    };
    const outcomes = () => client.of("completion/outcome") as Array<{ requestId: string; outcome: string; acceptedText?: string }>;
    const rejected = () => (client.of("completion/rejected") as Array<{ requestId: string }>).map((r) => r.requestId);
    return { client, provider, fdoc, ask, edit, outcomes, rejected };
  }

  it("typed_through_reports_typedThrough", async () => {
    const full = "foo(1)";
    const h = harness("x = ", (c) => full.slice(c - 4));
    // Typed by hand, VS Code asking again after each key: f, o, o, then "(" auto-closes to "()",
    // "1" goes inside, and ")" types over the auto-closed one.
    const first = await h.ask(4);
    for (const [at, text, replace] of [
      [4, "f", 0],
      [5, "o", 0],
      [6, "o", 0],
      [7, "()", 0],
      [8, "1", 0],
      [9, ")", 1],
    ] as Array<[number, string, number]>) {
      h.edit(at, text, replace);
      await h.ask(at + 1);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.outcomes().find((o) => o.requestId === first)).toEqual({ requestId: first, outcome: "typedThrough" });
    expect(h.rejected()).not.toContain(first);
    expect(h.client.of("completion/accepted")).toEqual([]);
    expect(h.outcomes().map((o) => o.outcome)).not.toContain("partial");

    // A suggestion ending in a newline: its text then Enter (auto-indented) is still typed through.
    const g = harness("z = ", () => "go()\n");
    const id = await g.ask(4);
    for (const [i, ch] of [..."go"].entries()) g.edit(4 + i, ch);
    g.edit(6, "()");
    g.edit(8, ")", 1);
    g.edit(8, "\n    ");
    expect(g.outcomes()).toContainEqual({ requestId: id, outcome: "typedThrough" });
  });

  it("hand_typed_word_then_divergence_reports_rejected", async () => {
    const h = harness("x = ", () => "value + 1");
    const id = await h.ask(4);
    for (const [i, ch] of [..."value "].entries()) h.edit(4 + i, ch);
    h.edit(10, "-"); // not "+": diverged after a whole word typed by hand
    expect(h.rejected()).toEqual([id]);
    expect(h.outcomes()).toEqual([]);

    // Part of a word, then something else: rejected too.
    const g = harness("y = ", () => "foo(1)");
    const id2 = await g.ask(4);
    g.edit(4, "f");
    g.edit(5, "x");
    expect(g.rejected()).toEqual([id2]);
  });

  it("stepping_through_whole_suggestion_reports_accepted", async () => {
    const h = harness("x = ", () => "compute(a, b)");
    const id = await h.ask(4);
    // accept-next-word three times covers the whole suggestion; no item command runs.
    h.edit(4, "compute");
    h.edit(11, "(a,");
    h.edit(14, " b)");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.outcomes()).toEqual([{ requestId: id, outcome: "accepted", acceptedText: "compute(a, b)" }]);
    expect(h.rejected()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("typed_prefix_hit_hands_off_the_watch_without_reporting", async () => {
    // The core serves the rest of the suggestion (a typed-prefix hit) after each key.
    const full = "compute(a)";
    const h = harness("x = ", (c) => full.slice(c - 4));
    const id = await h.ask(4);
    h.edit(4, "c");
    const hit = await h.ask(5);
    expect(hit).not.toBe(id);
    expect(h.outcomes()).toEqual([]);
    expect(h.rejected()).toEqual([]);
    // Tab on the hit's ghost text: accepted once, for the whole run (its original id); nothing else later.
    h.edit(5, "ompute(a)");
    h.provider.reportAccepted(hit);
    h.provider.reportAccepted(id);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.client.of("completion/accepted")).toEqual([{ requestId: id }]);
    expect(h.outcomes()).toEqual([]);
    expect(h.rejected()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    // accept-next-word into the hit's ghost text, then quiet: one partial with everything taken in the run.
    const g = harness("y = ", (c) => full.slice(c - 4));
    const gid = await g.ask(4);
    g.edit(4, "c");
    await g.ask(5);
    g.edit(5, "ompute");
    await g.ask(11);
    await vi.advanceTimersByTimeAsync(2000);
    expect(g.outcomes()).toEqual([{ requestId: gid, outcome: "partial", acceptedText: "compute" }]);
    expect(g.rejected()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backspace_after_typed_prefix_hit_does_not_report_rejected_early", async () => {
    const full = "value + 1";
    const h = harness("x = ", (c) => full.slice(c - 4));
    const id = await h.ask(4);
    h.edit(4, "v");
    await h.ask(5);
    h.edit(5, "a");
    await h.ask(6);
    h.edit(5, "", 1); // backspace: the latest hit no longer fits, the run still does
    expect(h.rejected()).toEqual([]);
    expect(h.outcomes()).toEqual([]);
    const hit = await h.ask(5);
    expect(h.rejected()).toEqual([]);
    // Then the user takes the rest with Tab.
    h.edit(5, "alue + 1");
    h.provider.reportAccepted(hit);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.client.of("completion/accepted")).toEqual([{ requestId: id }]);
    expect(h.rejected()).toEqual([]);
    expect(h.outcomes()).toEqual([]);
  });

  it("long_type_through_reports_once", async () => {
    // Far more typed-prefix hits than the tracker's limit of 8.
    const full = "computeTotal(alpha, beta)";
    const h = harness("x = ", (c) => full.slice(c - 4));
    const id = await h.ask(4);
    for (const [i, ch] of [...full].entries()) {
      h.edit(4 + i, ch);
      await h.ask(5 + i);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.outcomes()).toEqual([{ requestId: id, outcome: "typedThrough" }]);
    expect(h.rejected()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
