import { describe, expect, it } from "vitest";
import {
  ErrorCodes,
  PendingMap,
  RpcEndpoint,
  RpcError,
  decode,
  encode,
  isServerRequestId,
  type Message,
} from "../src/index";

/** An endpoint wired to an in-memory outbox; `sent()` parses what it wrote. */
function makeEndpoint() {
  const lines: string[] = [];
  const endpoint = new RpcEndpoint((line) => lines.push(line));
  const sent = () => lines.map((l) => decode(l) as Message & Record<string, unknown>);
  return { endpoint, lines, sent };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("jsonrpc", () => {
  it("encode_decode_roundtrip_single_line", () => {
    const msg: Message = {
      jsonrpc: "2.0",
      id: 7,
      method: "chat/send",
      params: { sessionId: "s", message: "line one\nline two\r\n end" },
    };
    const line = encode(msg);
    expect(line).not.toMatch(/[\n\r]/);
    expect(decode(line)).toEqual(msg);
    // Trailing newline / CR from the framing are tolerated.
    expect(decode(line + "\r\n")).toEqual(msg);
    // Garbage, blank lines and non-JSON-RPC objects decode to null.
    expect(decode("")).toBeNull();
    expect(decode("   ")).toBeNull();
    expect(decode("{not json")).toBeNull();
    expect(decode('{"jsonrpc":"1.0","id":1,"result":1}')).toBeNull();
    expect(decode("[1,2]")).toBeNull();
  });

  it("request_resolves_with_matching_id", async () => {
    const { endpoint, sent } = makeEndpoint();
    const a = endpoint.request<{ v: string }>("a", { x: 1 });
    const b = endpoint.request<{ v: string }>("b");
    const [ra, rb] = sent();
    expect(ra).toMatchObject({ jsonrpc: "2.0", method: "a", params: { x: 1 } });
    expect(rb).toMatchObject({ jsonrpc: "2.0", method: "b" });
    expect(typeof ra.id).toBe("number");
    expect(ra.id as number).toBeGreaterThan(0);
    expect(rb.id).not.toBe(ra.id);
    // Answer out of order; each promise gets its own result.
    endpoint.receive(encode({ jsonrpc: "2.0", id: rb.id as number, result: { v: "B" } }));
    endpoint.receive(encode({ jsonrpc: "2.0", id: ra.id as number, result: { v: "A" } }));
    await expect(a).resolves.toEqual({ v: "A" });
    await expect(b).resolves.toEqual({ v: "B" });
    // Error responses reject with an RpcError carrying the code.
    const c = endpoint.request("c");
    const rc = sent()[2];
    endpoint.receive(
      encode({ jsonrpc: "2.0", id: rc.id as number, error: { code: -32602, message: "busy" } }),
    );
    await expect(c).rejects.toMatchObject({ name: "RpcError", code: -32602, message: "busy" });
    // A response for an unknown id is ignored.
    expect(() =>
      endpoint.receive(encode({ jsonrpc: "2.0", id: 999, result: null })),
    ).not.toThrow();
  });

  it("server_to_client_request_is_answered_by_handler", async () => {
    const { endpoint, sent } = makeEndpoint();
    expect(isServerRequestId(-1)).toBe(true);
    expect(isServerRequestId(1)).toBe(false);
    endpoint.onRequest("workspace/applyEdit", async (params) => {
      expect(params).toEqual({ ops: [], save: true });
      return { applied: true };
    });
    endpoint.onRequest("fails", async () => {
      throw new RpcError(-32001, "model missing");
    });
    endpoint.onRequest("throws", async () => {
      throw new Error("boom");
    });
    const notes: unknown[] = [];
    endpoint.onNotification("chat/token", (p) => notes.push(p));

    endpoint.receive(
      encode({ jsonrpc: "2.0", id: -1, method: "workspace/applyEdit", params: { ops: [], save: true } }),
    );
    endpoint.receive(encode({ jsonrpc: "2.0", id: -2, method: "fails" }));
    endpoint.receive(encode({ jsonrpc: "2.0", id: -3, method: "throws" }));
    endpoint.receive(encode({ jsonrpc: "2.0", id: -4, method: "nope" }));
    endpoint.receive(encode({ jsonrpc: "2.0", method: "chat/token", params: { delta: "hi" } }));
    await flush();

    const out = sent();
    expect(out).toContainEqual({ jsonrpc: "2.0", id: -1, result: { applied: true } });
    expect(out).toContainEqual({
      jsonrpc: "2.0",
      id: -2,
      error: { code: -32001, message: "model missing" },
    });
    expect(out).toContainEqual({
      jsonrpc: "2.0",
      id: -3,
      error: { code: ErrorCodes.InternalError, message: "boom" },
    });
    expect(out).toContainEqual({
      jsonrpc: "2.0",
      id: -4,
      error: { code: ErrorCodes.MethodNotFound, message: "method not found: nope" },
    });
    expect(notes).toEqual([{ delta: "hi" }]);
  });

  it("abort_signal_rejects_pending_request", async () => {
    const { endpoint, sent } = makeEndpoint();
    const ctrl = new AbortController();
    const p = endpoint.request("completion/request", {}, ctrl.signal);
    const id = sent()[0].id as number;
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    // The late response is ignored.
    expect(() => endpoint.receive(encode({ jsonrpc: "2.0", id, result: {} }))).not.toThrow();
    // An already-aborted signal rejects without sending anything.
    const before = sent().length;
    await expect(endpoint.request("x", {}, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(sent().length).toBe(before);
  });

  it("rejectAll_fails_every_pending", async () => {
    const { endpoint } = makeEndpoint();
    const ps = [endpoint.request("a"), endpoint.request("b"), endpoint.request("c")];
    const err = new Error("core crashed");
    endpoint.rejectAll(err);
    for (const p of ps) await expect(p).rejects.toBe(err);
    // The endpoint stays usable after rejectAll; dispose() makes it inert.
    const later = endpoint.request("d");
    endpoint.dispose();
    await expect(later).rejects.toThrow(/disposed/);
    await expect(endpoint.request("e")).rejects.toThrow(/disposed/);
  });

  it("pending_map_times_out", async () => {
    const pending = new PendingMap();
    const p = new Promise((resolve, reject) => pending.add(1, { resolve, reject }, 10));
    expect(pending.size).toBe(1);
    await expect(p).rejects.toMatchObject({ name: "TimeoutError" });
    expect(pending.size).toBe(0);
    expect(pending.resolve(1, "late")).toBe(false);
  });
});
