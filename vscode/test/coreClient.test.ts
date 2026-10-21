import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient, CoreCrashed, type CoreState } from "../src/rpc/coreClient";
import { DEFAULT_SETTINGS } from "../src/settings";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fakeCore.mjs");

interface Harness {
  client: CoreClient;
  logs: Array<[string, string]>;
  states: CoreState[];
  /** Resolves once `count` log lines equal `message` (stderr and stdout are separate pipes, so no ordering is assumed). */
  waitForLog: (message: string, count?: number) => Promise<void>;
}

const clients: CoreClient[] = [];

function makeClient(env: Record<string, string> = {}, extra: Partial<ConstructorParameters<typeof CoreClient>[0]> = {}): Harness {
  const logs: Array<[string, string]> = [];
  const states: CoreState[] = [];
  const waiters = new Set<() => void>();
  const client = new CoreClient({
    binaryPath: { command: process.execPath, args: [FAKE], env },
    workspaceRoot: here,
    logLevel: "info",
    onLog: (level, message) => {
      logs.push([level, message]);
      for (const w of [...waiters]) w();
    },
    ...extra,
  });
  client.onDidChangeState((s) => states.push(s));
  clients.push(client);
  const waitForLog = (message: string, count = 1) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (logs.filter(([, m]) => m === message).length >= count) {
          waiters.delete(check);
          resolve();
        }
      };
      waiters.add(check);
      check();
    });
  return { client, logs, states, waitForLog };
}

/** Resolves once the client reaches `state` (or immediately if it is there). */
function waitForState(client: CoreClient, state: CoreState): Promise<void> {
  if (client.state === state) return Promise.resolve();
  return new Promise((resolve) => {
    const sub = client.onDidChangeState((s) => {
      if (s === state) {
        sub.dispose();
        resolve();
      }
    });
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
});

describe("CoreClient", () => {
  it("start_sends_initialize_and_returns_result", async () => {
    const { client, states, waitForLog } = makeClient();
    const indexReady = new Promise((resolve) => client.onNotification("index/ready", resolve));
    expect(client.state).toBe("stopped");
    const result = await client.start(DEFAULT_SETTINGS);
    expect(result).toEqual({
      capabilities: { completion: true, chat: true, bench: false },
      ollamaStatus: { ollama: "ok", detail: expect.any(String) },
      indexStatus: "building",
    });
    expect(client.state).toBe("ready");
    expect(states).toEqual(["starting", "ready"]);
    await expect(indexReady).resolves.toEqual({ files: 1, buildMs: 1 });
    await waitForLog("fake-core: initialize");

    // Requests after start work, and core→client requests reach onRequest.
    const items = await client.request("completion/request", {
      uri: "file:///a.py",
      position: { line: 3, character: 4 },
      requestId: "r1",
    });
    expect(items).toEqual({
      items: [{ text: "fake()", range: { start: { line: 3, character: 4 }, end: { line: 3, character: 4 } } }],
    });
    const edits: unknown[] = [];
    client.onRequest("workspace/applyEdit", async (params) => {
      edits.push(params);
      return { applied: true };
    });
    const events: string[] = [];
    const done = new Promise<unknown>((resolve) => {
      client.onNotification("chat/token", () => events.push("token"));
      client.onNotification("chat/toolCall", (p) => {
        events.push("toolCall");
        const { sessionId, toolCallId } = p as { sessionId: string; toolCallId: string };
        void client.request("chat/approve", { sessionId, toolCallId, decision: "once" });
      });
      client.onNotification("chat/toolResult", (p) => events.push(`toolResult:${(p as { ok: boolean }).ok}`));
      client.onNotification("chat/done", resolve);
    });
    await expect(client.request("chat/send", { sessionId: "s1", message: "hi", attachments: [] })).resolves.toEqual({});
    await expect(done).resolves.toEqual({ sessionId: "s1", stopReason: "done" });
    expect(events).toEqual(["token", "token", "toolCall", "toolResult:true"]);
    expect(edits).toHaveLength(1);
  });

  it("crash_rejects_pending_and_restarts_once", async () => {
    // Request #1 is initialize; request #2 kills the process before it answers.
    const { client, logs, states, waitForLog } = makeClient({ FAKE_CRASH_AFTER: "2" });
    await client.start(DEFAULT_SETTINGS);
    const pending = client.request("completion/request", { uri: "file:///a.py", position: { line: 0, character: 0 }, requestId: "r" });
    await expect(pending).rejects.toBeInstanceOf(CoreCrashed);
    await waitForState(client, "ready");
    expect(states).toEqual(["starting", "ready", "starting", "ready"]);
    expect(logs.some(([level, m]) => level === "warn" && /restart/i.test(m))).toBe(true);
    // The restarted process was initialized again (with the saved settings).
    await waitForLog("fake-core: initialize", 2);
  });

  it("crash_more_than_3_per_minute_stops_restarting", async () => {
    const { client, logs, states } = makeClient({ FAKE_CRASH_AFTER: "2" });
    await client.start(DEFAULT_SETTINGS);
    // Each request crashes the current process; three restarts are allowed.
    for (let i = 0; i < 3; i++) {
      await expect(client.request("ollama/status", {})).rejects.toBeInstanceOf(CoreCrashed);
      await waitForState(client, "ready");
    }
    await expect(client.request("ollama/status", {})).rejects.toBeInstanceOf(CoreCrashed);
    await waitForState(client, "crashed");
    expect(states.filter((s) => s === "starting")).toHaveLength(4);
    expect(states.at(-1)).toBe("crashed");
    expect(logs.some(([level]) => level === "error")).toBe(true);
    // A crashed client fails requests immediately instead of hanging.
    await expect(client.request("ollama/status", {})).rejects.toThrow(/not running/);
  });

  it("stop_sends_shutdown_and_exits_0", async () => {
    const { client, logs, states } = makeClient();
    await client.start(DEFAULT_SETTINGS);
    const exit = await client.stop();
    expect(exit).toEqual({ code: 0, signal: null });
    expect(logs).toContainEqual(["info", "fake-core: shutdown"]);
    expect(client.state).toBe("stopped");
    expect(states.at(-1)).toBe("stopped");
    // stop() is idempotent and a stopped client never auto-restarts.
    await expect(client.stop()).resolves.toBeUndefined();
    expect(client.state).toBe("stopped");
  });

  it("stop_kills_a_core_that_ignores_shutdown", async () => {
    const { client } = makeClient({ FAKE_IGNORE_SHUTDOWN: "1" }, { shutdownTimeoutMs: 200 });
    await client.start(DEFAULT_SETTINGS);
    const exit = await client.stop();
    expect(exit?.signal).toBe("SIGKILL");
    expect(client.state).toBe("stopped");
  });

  it("cancellation_token_rejects_request", async () => {
    const { client } = makeClient({ FAKE_DELAY_MS: "5000" });
    await client.start(DEFAULT_SETTINGS);
    let cancel = () => {};
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        cancel = () => {
          token.isCancellationRequested = true;
          listener();
        };
        return { dispose: () => {} };
      },
    };
    const p = client.request("completion/request", { uri: "file:///a.py", position: { line: 0, character: 0 }, requestId: "r" }, token);
    cancel();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("index_ready_before_initialize_response_is_delivered", async () => {
    const { client } = makeClient({ FAKE_INDEX_FIRST: "1" });
    const seen: Array<[unknown, CoreState]> = [];
    client.onNotification("index/ready", (p) => seen.push([p, client.state]));
    const result = await client.start(DEFAULT_SETTINGS);
    expect(result.indexStatus).toBe("building");
    // Delivered while the client was still starting; the client must not lose it.
    expect(seen).toEqual([[{ files: 1, buildMs: 1 }, "starting"]]);
  });

  it("spawn_failure_goes_straight_to_crashed", async () => {
    const logs: Array<[string, string]> = [];
    const states: CoreState[] = [];
    const client = new CoreClient({
      binaryPath: join(here, "does-not-exist", "localpilot-core"),
      workspaceRoot: here,
      logLevel: "info",
      onLog: (level, message) => logs.push([level, message]),
    });
    clients.push(client);
    client.onDidChangeState((s) => states.push(s));
    await expect(client.start(DEFAULT_SETTINGS)).rejects.toThrow(/ENOENT/);
    expect(client.state).toBe("crashed");
    expect(states).toEqual(["starting", "crashed"]);
    expect(logs.filter(([level]) => level === "error")).toHaveLength(1);
    expect(logs.some(([level]) => level === "warn")).toBe(false);
  });

  it("notify_never_throws_when_stdin_is_closed", async () => {
    const { client, logs } = makeClient({ FAKE_IGNORE_SHUTDOWN: "1" }, { shutdownTimeoutMs: 200 });
    await client.start(DEFAULT_SETTINGS);
    const internals = client as unknown as { running: { child: ChildProcess } };
    internals.running.child.stdin!.end();
    expect(() => client.notify("textDocument/didSave", { uri: "file:///a.py" })).not.toThrow();
    expect(logs.some(([level, m]) => level === "warn" && /textDocument\/didSave/.test(m))).toBe(true);
  });
});
