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
});
