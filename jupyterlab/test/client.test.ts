import { ServerConnection } from '@jupyterlab/services';
import { RpcError } from '@localpilot/rpc-client';
import { CoreDisconnected, InitializeResult, NotificationQueue, WsCoreClient } from '../src/client';
import { DEFAULT_SETTINGS, Settings } from '../src/settings';
import { MockWebSocket } from './mockWebSocket';

const INIT_RESULT: InitializeResult = {
  capabilities: { completion: true, chat: true, bench: false },
  ollamaStatus: { ollama: 'ok', detail: 'ollama 0.12 at http://localhost:11434' },
  indexStatus: 'building'
};

function serverSettings(overrides: Partial<ServerConnection.ISettings> = {}): ServerConnection.ISettings {
  return ServerConnection.makeSettings({
    baseUrl: 'http://localhost:8888/base/',
    wsUrl: 'ws://localhost:8888/base/',
    token: 'secret token',
    appendToken: true,
    WebSocket: MockWebSocket as unknown as typeof WebSocket,
    ...overrides
  });
}

const logs: string[] = [];

function makeClient(settings: Partial<Settings> = {}): WsCoreClient {
  const s: Settings = { ...DEFAULT_SETTINGS, ...settings };
  return new WsCoreClient({ serverSettings: serverSettings(), settings: () => s, onLog: (m) => logs.push(m) });
}

/** Lets pending promise callbacks run (no timers advance). */
async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

/** Opens the current socket and answers its initialize. */
async function connect(result: InitializeResult = INIT_RESULT): Promise<MockWebSocket> {
  const ws = MockWebSocket.last;
  ws.open();
  await flush();
  ws.respond('initialize', result);
  await flush();
  return ws;
}

let client: WsCoreClient | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  MockWebSocket.reset();
  logs.length = 0;
});

afterEach(() => {
  client?.dispose();
  client = undefined;
  jest.useRealTimers();
});

describe('WsCoreClient', () => {
  it('connects_and_initializes_with_settings', async () => {
    client = makeClient({ chatModel: 'llama-test', completionsEnabled: false });
    const statuses: unknown[] = [];
    client.onStatus((s) => statuses.push(s));
    const reconnects = jest.fn();
    client.onReconnect(reconnects);

    // Sent before the socket is up: the notification is queued, the request waits.
    client.notify('textDocument/didOpen', { uri: 'file:///a.py', version: 1, text: 'x' });
    const sessions = client.request('chat/listSessions', {});
    client.start();

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.last;
    // Jupyter's own rule: the token rides on the URL only when appendToken is set.
    expect(ws.url).toBe('ws://localhost:8888/base/localpilot/rpc?token=secret%20token');
    expect(client.state).toBe('connecting');

    ws.open();
    await flush();
    const [init, ...rest] = ws.messages();
    expect(rest).toHaveLength(0); // nothing goes out before initialize is answered
    expect(init.method).toBe('initialize');
    // The core always gets completionsEnabled: true; the client gates completions itself.
    expect(init.params?.settings).toEqual({ ...DEFAULT_SETTINGS, chatModel: 'llama-test', completionsEnabled: true });

    ws.respond('initialize', INIT_RESULT);
    await flush();
    expect(client.state).toBe('ready');
    expect(client.initializeResult).toEqual(INIT_RESULT);
    await expect(client.whenReady()).resolves.toEqual(INIT_RESULT);
    expect(statuses).toEqual([INIT_RESULT.ollamaStatus]);
    expect(reconnects).not.toHaveBeenCalled(); // the first connection is not a reconnect

    const methods = ws.messages().map((m) => m.method);
    expect(methods).toEqual(['initialize', 'textDocument/didOpen', 'chat/listSessions']);
    ws.respond('chat/listSessions', { sessions: [] });
    await expect(sessions).resolves.toEqual({ sessions: [] });

    // Later core notifications reach their handlers; `status` also reaches onStatus.
    const tokens: unknown[] = [];
    client.onNotification('chat/token', (p) => tokens.push(p));
    ws.receive({ jsonrpc: '2.0', method: 'chat/token', params: { sessionId: 's', text: 'hi' } });
    ws.receive({ jsonrpc: '2.0', method: 'status', params: { ollama: 'down', detail: 'connection refused' } });
    expect(tokens).toEqual([{ sessionId: 's', text: 'hi' }]);
    expect(statuses).toEqual([INIT_RESULT.ollamaStatus, { ollama: 'down', detail: 'connection refused' }]);

    // Core → client requests (negative ids) are answered on the same socket.
    client.onRequest('workspace/applyEdit', () => ({ applied: true }));
    ws.receive({ jsonrpc: '2.0', id: -1, method: 'workspace/applyEdit', params: { sessionId: 's' } });
    await flush();
    expect(ws.messages().pop()).toEqual({ jsonrpc: '2.0', id: -1, result: { applied: true } });
  });

  it('builds the socket URL without a token when Jupyter does not append one', () => {
    const s = serverSettings({ appendToken: false });
    client = new WsCoreClient({ serverSettings: s, settings: () => DEFAULT_SETTINGS, onLog: () => undefined });
    client.start();
    expect(MockWebSocket.last.url).toBe('ws://localhost:8888/base/localpilot/rpc');
  });

  it('reconnects_with_backoff_and_replays_didOpen', async () => {
    client = makeClient();
    const order: string[] = [];
    const docs = new Map([['file:///nb.ipynb.cell0.py', 'import os']]);
    client.onReconnect(() => {
      order.push('reconnect');
      for (const [uri, text] of docs) {
        client!.notify('textDocument/didOpen', { uri, languageId: 'python', version: 1, text });
      }
    });
    client.start();
    const first = await connect();
    expect(client.state).toBe('ready');

    // The core restarted: the server closes every socket with 1012.
    first.serverClose(1012, 'LocalPilot core restarted');
    expect(client.state).toBe('reconnecting');
    // Sent while disconnected: dropped (the replay brings the core up to date).
    client.notify('textDocument/didChange', { uri: 'file:///x.py', version: 2, contentChanges: [{ text: 'y' }] });

    // Backoff 0.5 s, 1 s, 2 s, 4 s, 8 s, then capped at 10 s; failed attempts never open.
    const delays = [500, 1000, 2000, 4000, 8000, 10000, 10000];
    for (const [i, delay] of delays.entries()) {
      const before = MockWebSocket.instances.length;
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(MockWebSocket.instances).toHaveLength(before);
      await jest.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(before + 1);
      if (i < delays.length - 1) MockWebSocket.last.serverClose(1006);
    }

    // This attempt succeeds: initialize first, and the replay only after its answer.
    const ws = MockWebSocket.last;
    ws.open();
    await flush();
    expect(ws.messages().map((m) => m.method)).toEqual(['initialize']);
    expect(order).toEqual([]);
    ws.respond('initialize', INIT_RESULT);
    await flush();
    expect(order).toEqual(['reconnect']);
    expect(client.state).toBe('ready');
    const sent = ws.messages();
    expect(sent.map((m) => m.method)).toEqual(['initialize', 'textDocument/didOpen']);
    expect(sent[1].params).toEqual({
      uri: 'file:///nb.ipynb.cell0.py',
      languageId: 'python',
      version: 1,
      text: 'import os'
    });
    // The didChange sent while disconnected never went anywhere.
    expect(MockWebSocket.instances.flatMap((s) => s.messages()).some((m) => m.method === 'textDocument/didChange')).toBe(false);

    // A successful initialize resets the backoff to 0.5 s.
    ws.serverClose(1012, 'LocalPilot core restarted');
    const before = MockWebSocket.instances.length;
    await jest.advanceTimersByTimeAsync(500);
    expect(MockWebSocket.instances).toHaveLength(before + 1);
    await connect();
    expect(order).toEqual(['reconnect', 'reconnect']);
  });

  it('disconnect_mid_turn_rejects_pending_and_emits_error', async () => {
    client = makeClient();
    const disconnects: CoreDisconnected[] = [];
    client.onDisconnect((e) => disconnects.push(e));
    const states: string[] = [];
    client.onStateChanged((s) => states.push(s));
    client.start();
    const ws = await connect();

    // A chat turn is streaming and a history request is in flight.
    const history = client.request('chat/history', { sessionId: 's1' });
    let historyError: unknown;
    history.catch((e) => (historyError = e));
    ws.receive({ jsonrpc: '2.0', method: 'chat/token', params: { sessionId: 's1', text: 'par' } });

    ws.serverClose(1012, 'LocalPilot core restarted');
    await flush();

    expect(historyError).toBeInstanceOf(CoreDisconnected);
    expect(historyError).not.toBeInstanceOf(RpcError);
    expect((historyError as CoreDisconnected).code).toBe(1012);
    expect((historyError as CoreDisconnected).reason).toBe('LocalPilot core restarted');
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0]).toBeInstanceOf(CoreDisconnected);
    expect(disconnects[0].code).toBe(1012);
    expect(states).toEqual(['connecting', 'ready', 'reconnecting']);

    // Requests made while disconnected wait for the next connection, abortable.
    const aborter = new AbortController();
    const aborted = client.request('completion/request', {}, aborter.signal);
    const later = client.request('chat/listSessions', {});
    aborter.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });

    await jest.advanceTimersByTimeAsync(500);
    const next = await connect();
    expect(next.messages().map((m) => m.method)).toEqual(['initialize', 'chat/listSessions']);
    next.respond('chat/listSessions', { sessions: [] });
    await expect(later).resolves.toEqual({ sessions: [] });

    // Failed attempts that never opened do not emit another disconnect.
    next.serverClose(1006);
    await jest.advanceTimersByTimeAsync(500);
    MockWebSocket.last.serverClose(1006);
    expect(disconnects).toHaveLength(2);
  });

  it('disconnect_mid_turn_after_core_exited_answers_rejects_with_CoreDisconnected', async () => {
    // The real sequence on a core exit: the bridge answers every in-flight
    // request with -32603 "LocalPilot core exited", then closes with 1012.
    client = makeClient();
    const disconnects: CoreDisconnected[] = [];
    client.onDisconnect((e) => disconnects.push(e));
    client.start();
    const ws = await connect();
    const send = client.request('chat/send', { sessionId: 's1', text: 'hi' });
    let sendError: unknown;
    send.catch((e) => (sendError = e));
    const other = client.request('chat/listSessions', {});
    let otherError: unknown;
    other.catch((e) => (otherError = e));
    await flush();
    const sendReq = ws.messages().find((m) => m.method === 'chat/send');
    ws.receive({ jsonrpc: '2.0', id: sendReq?.id, error: { code: -32603, message: 'LocalPilot core exited' } });
    await flush();
    expect(sendError).toBeInstanceOf(CoreDisconnected);
    expect((sendError as CoreDisconnected).code).toBe(1012);
    expect(disconnects).toHaveLength(0); // the close has not happened yet

    ws.serverClose(1012, 'LocalPilot core restarted');
    await flush();
    expect(otherError).toBeInstanceOf(CoreDisconnected);
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0].code).toBe(1012);
    expect(client.state).toBe('reconnecting');

    // Other -32603 errors stay RpcErrors.
    await jest.advanceTimersByTimeAsync(500);
    const next = await connect();
    const failing = client.request('chat/history', { sessionId: 'nope' });
    await flush();
    const req = next.messages().find((m) => m.method === 'chat/history');
    next.receive({ jsonrpc: '2.0', id: req?.id, error: { code: -32603, message: 'unknown session' } });
    await expect(failing).rejects.toBeInstanceOf(RpcError);
  });

  it('queued_notifications_are_coalesced_per_document', async () => {
    client = makeClient();
    client.notify('textDocument/didOpen', { uri: 'file:///a.py', version: 1, text: 'x' });
    client.notify('textDocument/didChange', { uri: 'file:///a.py', version: 2, contentChanges: [{ text: 'xy' }] });
    client.notify('custom/ping', { n: 1 });
    client.notify('textDocument/didOpen', { uri: 'file:///b.py', version: 1, text: 'b' });
    client.notify('textDocument/didClose', { uri: 'file:///b.py' });
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    client.notify('textDocument/didChange', { uri: 'file:///c.py', version: 3, contentChanges: [{ range, text: 'i' }] });
    client.notify('textDocument/didChange', { uri: 'file:///c.py', version: 4, contentChanges: [{ text: 'full' }] });
    client.notify('textDocument/didSave', { uri: 'file:///a.py' });
    client.notify('textDocument/didSave', { uri: 'file:///a.py' });
    client.start();
    const ws = await connect();
    expect(ws.messages().slice(1).map((m) => [m.method, m.params])).toEqual([
      ['textDocument/didOpen', { uri: 'file:///a.py', version: 2, text: 'xy' }],
      ['custom/ping', { n: 1 }],
      ['textDocument/didChange', { uri: 'file:///c.py', version: 4, contentChanges: [{ text: 'full' }] }],
      ['textDocument/didSave', { uri: 'file:///a.py' }]
    ]);
  });

  it('NotificationQueue keeps incremental changes in order and closes of sent documents', () => {
    const q = new NotificationQueue();
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    q.push('textDocument/didChange', { uri: 'u', version: 1, contentChanges: [{ range, text: 'a' }] });
    q.push('textDocument/didChange', { uri: 'u', version: 2, contentChanges: [{ range, text: 'b' }] });
    expect(q.length).toBe(2);
    q.push('textDocument/didClose', { uri: 'u' });
    expect(q.drain()).toEqual([['textDocument/didClose', { uri: 'u' }]]);
    // A full text folded into a queued didOpen also supersedes queued incremental changes.
    q.push('textDocument/didOpen', { uri: 'v', version: 1, text: 'a' });
    q.push('textDocument/didChange', { uri: 'v', version: 2, contentChanges: [{ range, text: 'b' }] });
    q.push('textDocument/didChange', { uri: 'v', version: 3, contentChanges: [{ text: 'full' }] });
    expect(q.drain()).toEqual([['textDocument/didOpen', { uri: 'v', version: 3, text: 'full' }]]);
  });

  it('initialize_unanswered_for_30s_is_a_disconnect', async () => {
    client = makeClient();
    client.start();
    const ws = MockWebSocket.last;
    ws.open();
    await flush();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(ws.closedWith).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(ws.closedWith?.code).toBe(4408);
    expect(client.state).toBe('connecting');
    await jest.advanceTimersByTimeAsync(500);
    expect(MockWebSocket.instances).toHaveLength(2);
    await connect();
    expect(client.state).toBe('ready');
    // A late answer on the old socket changes nothing.
    ws.respond('initialize', INIT_RESULT);
    await flush();
    expect(client.state).toBe('ready');
  });

  it('whenReady forgets an aborted waiter', async () => {
    client = makeClient();
    client.start();
    const waiters = (client as unknown as { waiters: Set<unknown> }).waiters;
    const aborter = new AbortController();
    const waiting = client.whenReady(aborter.signal);
    expect(waiters.size).toBe(1);
    aborter.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(waiters.size).toBe(0);
  });

  it('keeps retrying initialize while the server refuses it, and reconnect() retries at once', async () => {
    client = makeClient();
    const replays = jest.fn(() => client!.notify('textDocument/didOpen', { uri: 'file:///a.py', version: 3, text: 'now' }));
    client.onReconnect(replays);
    client.notify('textDocument/didOpen', { uri: 'file:///a.py', version: 1, text: 'old' });
    client.start();
    const ws = MockWebSocket.last;
    ws.open();
    await flush();
    const refuse = () => {
      const init = [...ws.messages()].reverse().find((m) => m.method === 'initialize');
      ws.receive({
        jsonrpc: '2.0',
        id: init?.id,
        error: { code: -32603, message: 'LocalPilot core crashed; POST /localpilot/restart to start it again' }
      });
    };
    const initCount = () => ws.messages().filter((m) => m.method === 'initialize').length;
    refuse();
    await flush();
    expect(client.state).toBe('crashed');
    expect(client.lastError?.message).toContain('POST /localpilot/restart');
    await expect(client.request('chat/listSessions', {})).rejects.toThrow('POST /localpilot/restart');
    // While crashed nothing is queued (it could grow without bound).
    client.notify('textDocument/didChange', { uri: 'file:///a.py', version: 2, contentChanges: [{ text: 'mid' }] });

    // Another tab (or the server owner) may restart the core: re-ask on the same
    // socket with the usual backoff, without opening new sockets.
    await jest.advanceTimersByTimeAsync(499);
    expect(initCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(initCount()).toBe(2);
    refuse();
    await flush();
    expect(client.state).toBe('crashed');
    expect(logs.filter((l) => l.includes('initialize refused'))).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(999);
    expect(initCount()).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(initCount()).toBe(3);
    ws.respond('initialize', INIT_RESULT);
    await flush();
    expect(client.state).toBe('ready');
    expect(client.lastError).toBeUndefined();
    expect(MockWebSocket.instances).toHaveLength(1);
    // The queue was dropped at the crash; the first ready replays instead.
    expect(replays).toHaveBeenCalledTimes(1);
    expect(ws.messages().map((m) => m.method)).toEqual(['initialize', 'initialize', 'initialize', 'textDocument/didOpen']);
    expect(ws.messages()[3].params).toEqual({ uri: 'file:///a.py', version: 3, text: 'now' });

    // reconnect() (after this tab's POST /localpilot/restart): a fresh socket at once.
    client.reconnect();
    expect(ws.closedWith?.code).toBe(1000);
    expect(MockWebSocket.instances).toHaveLength(2);
    await connect();
    expect(client.state).toBe('ready');
  });

  it('dispose closes the socket, rejects pending requests and never reconnects', async () => {
    client = makeClient();
    client.start();
    const ws = await connect();
    const pending = client.request('chat/history', { sessionId: 's1' });
    client.dispose();
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(ws.closedWith?.code).toBe(1000);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(client.state).toBe('disposed');
  });
});
