import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { ErrorCodes, RpcEndpoint, RpcError } from '@localpilot/rpc-client';
import type { IDisposable } from '@lumino/disposable';
import { coreInitSettings, type Settings } from './settings';

/** `status` notification params, and `InitializeResult.ollamaStatus`. */
export interface OllamaStatus {
  ollama: 'ok' | 'down' | 'modelMissing';
  detail: string;
}

export interface InitializeResult {
  capabilities: { completion: boolean; chat: boolean; bench: boolean };
  ollamaStatus: OllamaStatus;
  indexStatus: 'building' | 'ready';
}

/**
 * - `idle`: `start()` not called yet;
 * - `connecting`: the first connection (socket + `initialize`) is in progress;
 * - `ready`: `initialize` answered; requests and notifications flow;
 * - `reconnecting`: the socket closed; waiting for the backoff timer or a new socket;
 * - `crashed`: the server refused `initialize` (its core is crashed or cannot
 *   start); `initialize` is re-sent on the open socket with the usual backoff
 *   (any tab, or the server owner, may restart the core), and `reconnect()`
 *   retries at once (after this tab's `POST /localpilot/restart`);
 * - `disposed`.
 */
export type ConnectionState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'crashed' | 'disposed';

/**
 * "The core went away": the one error type for that, whichever way it shows.
 * - When the server's core exits, the bridge first answers every in-flight
 *   request with -32603 "LocalPilot core exited" and then closes the socket
 *   with 1012. Those answers are mapped to `CoreDisconnected(1012, …)`.
 * - Any other close (network, server stop, `initialize` timeout) rejects what
 *   is still pending with `CoreDisconnected(code, reason)`.
 * `onDisconnect` listeners receive one per closed socket. It is never an `RpcError`.
 */
export class CoreDisconnected extends Error {
  override name = 'CoreDisconnected';
  constructor(
    readonly code: number,
    readonly reason: string
  ) {
    super(`LocalPilot lost its connection to the Jupyter server (${code}${reason ? `: ${reason}` : ''})`);
  }
}

export interface WsCoreClientOptions {
  /** Defaults to `ServerConnection.makeSettings()`; in the plugin, `app.serviceManager.serverSettings`. */
  serverSettings?: ServerConnection.ISettings;
  /** Read at every `initialize`; the client sends `coreInitSettings(settings())`. */
  settings: () => Settings;
  /** First reconnect delay, doubled per failed attempt (default 500 ms). */
  initialBackoffMs?: number;
  /** Reconnect delay cap (default 10 000 ms). */
  maxBackoffMs?: number;
  /** An unanswered `initialize` counts as a dead connection after this (default 30 000 ms). */
  initializeTimeoutMs?: number;
  onLog?: (message: string) => void;
}

/** `ws(s)://<host><base_url>localpilot/rpc`, plus `?token=` exactly when Jupyter itself would add it. */
export function rpcUrl(server: ServerConnection.ISettings): string {
  const url = URLExt.join(server.wsUrl, 'localpilot', 'rpc');
  return server.appendToken && server.token ? `${url}?token=${encodeURIComponent(server.token)}` : url;
}

class Listeners<T> {
  private readonly set = new Set<(value: T) => void>();

  constructor(private readonly onLog: (message: string) => void) {}

  add(listener: (value: T) => void): IDisposable {
    this.set.add(listener);
    let disposed = false;
    return {
      get isDisposed() {
        return disposed;
      },
      dispose: () => {
        disposed = true;
        this.set.delete(listener);
      }
    };
  }

  emit(value: T): void {
    for (const listener of [...this.set]) {
      try {
        listener(value);
      } catch (e) {
        this.onLog(`listener threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  clear(): void {
    this.set.clear();
  }
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** The bridge's answer to requests in flight when the core exits (just before its 1012 close). */
const CORE_EXITED = 'LocalPilot core exited';

/** Maps the bridge's "core exited" error answer to `CoreDisconnected`; other errors pass through. */
export function toCoreDisconnected(error: unknown): unknown {
  if (error instanceof RpcError && error.code === ErrorCodes.InternalError && error.message.startsWith(CORE_EXITED)) {
    return new CoreDisconnected(1012, error.message);
  }
  return error;
}

const DOCUMENT_PREFIX = 'textDocument/';

function docUri(params: unknown): string | undefined {
  const uri = (params as { uri?: unknown } | null | undefined)?.uri;
  return typeof uri === 'string' ? uri : undefined;
}

function isFullText(params: unknown): boolean {
  const changes = (params as { contentChanges?: Array<{ range?: unknown }> }).contentChanges;
  return Array.isArray(changes) && changes.length > 0 && changes[changes.length - 1].range == null;
}

/**
 * Notifications sent before the first connection, in order, keeping at most
 * what the core needs per document (`textDocument/*`, keyed on `params.uri`):
 * - `didOpen` replaces everything queued for its uri;
 * - a full-text `didChange` drops every queued `didChange` for its uri and is
 *   folded into a queued `didOpen` (text, version) or else appended;
 *   incremental ones are appended;
 * - `didClose` drops everything queued for its uri, and is itself dropped
 *   when the `didOpen` was still queued;
 * - `didSave` replaces a queued `didSave`.
 * Other notifications are kept in order.
 */
export class NotificationQueue {
  private items: Array<[string, unknown]> = [];

  get length(): number {
    return this.items.length;
  }

  push(method: string, params: unknown): void {
    const uri = method.startsWith(DOCUMENT_PREFIX) ? docUri(params) : undefined;
    if (uri === undefined) {
      this.items.push([method, params]);
      return;
    }
    const forUri = (m?: string) => (item: [string, unknown]) =>
      item[0].startsWith(DOCUMENT_PREFIX) && docUri(item[1]) === uri && (m === undefined || item[0] === m);
    switch (method) {
      case 'textDocument/didOpen':
        this.remove(forUri());
        break;
      case 'textDocument/didChange': {
        if (!isFullText(params)) break;
        // A full text supersedes every queued change for the uri.
        this.remove(forUri('textDocument/didChange'));
        const open = this.items.find(forUri('textDocument/didOpen'));
        if (open) {
          const changes = (params as { contentChanges: Array<{ text: string }> }).contentChanges;
          const version = (params as { version?: unknown }).version;
          open[1] = { ...(open[1] as object), text: changes[changes.length - 1].text, ...(version !== undefined ? { version } : {}) };
          return;
        }
        break;
      }
      case 'textDocument/didClose': {
        const hadOpen = this.items.some(forUri('textDocument/didOpen'));
        this.remove(forUri());
        if (hadOpen) return;
        break;
      }
      case 'textDocument/didSave':
        this.remove(forUri('textDocument/didSave'));
        break;
    }
    this.items.push([method, params]);
  }

  /** Empties the queue and returns what it held, in order. */
  drain(): Array<[string, unknown]> {
    const items = this.items;
    this.items = [];
    return items;
  }

  private remove(pred: (item: [string, unknown]) => boolean): void {
    this.items = this.items.filter((item) => !pred(item));
  }
}

function abortError(): Error {
  const err = new Error('request aborted');
  err.name = 'AbortError';
  return err;
}

const QUEUE_STATES: ReadonlyArray<ConnectionState> = ['idle', 'connecting'];
const RETRY_STATES: ReadonlyArray<ConnectionState> = ['connecting', 'reconnecting', 'crashed'];

/**
 * JSON-RPC to the LocalPilot core through the Jupyter server's
 * `WS /localpilot/rpc` bridge: one `RpcEndpoint` (from `@localpilot/rpc-client`)
 * for the client's lifetime, written to whichever socket is current, one
 * message per text frame. Handlers registered with `onNotification` /
 * `onRequest` therefore survive reconnects.
 *
 * Connection: open → `initialize { settings }` → `ready`. On any close
 * (1012 when the server's core restarted, a network drop, the server going
 * away) pending requests reject with `CoreDisconnected`, `onDisconnect` fires,
 * and the client reconnects after 0.5 s, 1 s, 2 s … capped at 10 s (reset by
 * a successful `initialize`). The new core starts with an empty document
 * overlay, so after every re-`initialize` the client fires `onReconnect` —
 * DocumentSync (Task 3) replays `didOpen` for all its documents there.
 *
 * - `request()` waits while (re)connecting (honouring its `AbortSignal`) and
 *   rejects at once when `crashed` (with the server's `RpcError`; check
 *   `state` to tell "core down" from other errors) or disposed.
 * - `notify()` before the first `ready` (`idle`/`connecting`) is queued, with
 *   `textDocument/*` coalesced per uri (`NotificationQueue`), and flushed right
 *   after `initialize`. Otherwise, while not ready (`reconnecting`, `crashed`)
 *   it is dropped, and `onReconnect` fires on the next `ready` so the
 *   subscriber replays its state. A crash before the first `ready` drops the
 *   queue and switches to that replay too.
 * - An `initialize` unanswered for 30 s counts as a dead socket: it is closed
 *   and the client retries with backoff.
 */
export class WsCoreClient implements IDisposable {
  readonly url: string;
  private readonly server: ServerConnection.ISettings;
  private readonly endpoint: RpcEndpoint;
  private readonly log: (message: string) => void;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly initializeTimeoutMs: number;

  private _state: ConnectionState = 'idle';
  private ws?: WebSocket;
  private opened = false;
  private everReady = false;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  /** A crash before the first ready: the queue was dropped, so the first ready replays. */
  private replayPending = false;
  private readonly queued = new NotificationQueue();
  private readonly waiters = new Set<Waiter<InitializeResult>>();
  private initTimer?: ReturnType<typeof setTimeout>;
  private _initializeResult?: InitializeResult;
  private _lastError?: Error;

  private readonly reconnectListeners: Listeners<void>;
  private readonly statusListeners: Listeners<OllamaStatus>;
  private readonly disconnectListeners: Listeners<CoreDisconnected>;
  private readonly stateListeners: Listeners<ConnectionState>;

  constructor(private readonly options: WsCoreClientOptions) {
    this.server = options.serverSettings ?? ServerConnection.makeSettings();
    this.url = rpcUrl(this.server);
    this.log = options.onLog ?? ((m) => console.warn(`LocalPilot: ${m}`));
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? 30_000;
    this.reconnectListeners = new Listeners(this.log);
    this.statusListeners = new Listeners(this.log);
    this.disconnectListeners = new Listeners(this.log);
    this.stateListeners = new Listeners(this.log);
    this.endpoint = new RpcEndpoint((line) => this.sendLine(line), { onError: this.log });
    this.endpoint.onNotification('status', (params) => this.statusListeners.emit(params as OllamaStatus));
  }

  get state(): ConnectionState {
    return this._state;
  }

  get isDisposed(): boolean {
    return this._state === 'disposed';
  }

  /** The latest `initialize` answer (the server's cached one for later tabs). */
  get initializeResult(): InitializeResult | undefined {
    return this._initializeResult;
  }

  /** Why the client is `crashed` (the server's refusal of `initialize`). */
  get lastError(): Error | undefined {
    return this._lastError;
  }

  /** Opens the first connection; later calls do nothing. */
  start(): void {
    if (this._state !== 'idle') return;
    this.setState('connecting');
    this.connect();
  }

  /**
   * Drops the current socket (if any) and connects at once with a fresh
   * backoff. Use after `POST /localpilot/restart` when the client is
   * `crashed` (the server closes sockets itself only when a running core exits).
   */
  reconnect(): void {
    if (this._state === 'disposed') return;
    this.clearTimer();
    this.attempt = 0;
    if (this.ws) this.dropSocket(this.ws, 1000, 'reconnecting');
    this.setState(this.everReady ? 'reconnecting' : 'connecting');
    this.connect();
  }

  /** Resolves when the client is `ready`; rejects when `crashed`, disposed or `signal` aborts. */
  whenReady(signal?: AbortSignal): Promise<InitializeResult> {
    if (this._state === 'ready' && this._initializeResult) return Promise.resolve(this._initializeResult);
    if (this._state === 'disposed') return Promise.reject(new Error('LocalPilot client disposed'));
    if (this._state === 'crashed') return Promise.reject(this._lastError ?? new Error('LocalPilot core is not running'));
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<InitializeResult>((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(waiter);
        reject(abortError());
      };
      const waiter: Waiter<InitializeResult> = {
        resolve: (r) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(r);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        }
      };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Sends a request once the client is ready. Rejects with `CoreDisconnected`
   * if the core goes away before the answer (the bridge's "core exited" answer
   * or a socket close), with an `RpcError` when the core (or the server)
   * answers with another error, and with an `AbortError` on `signal`.
   */
  async request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this._state !== 'ready') await this.whenReady(signal);
    try {
      return await this.endpoint.request<T>(method, params, signal);
    } catch (e) {
      throw toCoreDisconnected(e);
    }
  }

  /** Fire-and-forget; see the class comment for what happens while not ready. */
  notify(method: string, params?: unknown): void {
    if (this._state === 'ready') {
      try {
        this.endpoint.notify(method, params);
      } catch (e) {
        this.log(`dropped ${method}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (!this.everReady && !this.replayPending && QUEUE_STATES.includes(this._state)) {
      this.queued.push(method, params);
    }
  }

  /** Core notifications (`chat/token`, `ollama/pullProgress`, …); kept across reconnects. */
  onNotification(method: string, handler: (params: unknown) => void): IDisposable {
    return wrap(this.endpoint.onNotification(method, handler));
  }

  /** Answers core→client requests (`workspace/applyEdit`); one handler per method. */
  onRequest(method: string, handler: (params: unknown) => unknown): IDisposable {
    return wrap(this.endpoint.onRequest(method, handler));
  }

  /**
   * Fires after every successful re-`initialize`, i.e. every `ready` except
   * the first one, unless notifications were dropped before it (a crash before
   * the first `ready`): the server's core may be new, with an empty overlay,
   * so re-send `didOpen` for every synced document here. Runs before waiting
   * requests are released.
   */
  onReconnect(listener: () => void): IDisposable {
    return this.reconnectListeners.add(listener);
  }

  /** Ollama status: from each `initialize` answer and every `status` notification. */
  onStatus(listener: (status: OllamaStatus) => void): IDisposable {
    return this.statusListeners.add(listener);
  }

  /**
   * The socket closed after it had opened (e.g. 1012 mid chat turn): end
   * running turns with this error. Also fires from `dispose()` and
   * `reconnect()` on a ready client; check `isDisposed` before showing it.
   */
  onDisconnect(listener: (error: CoreDisconnected) => void): IDisposable {
    return this.disconnectListeners.add(listener);
  }

  onStateChanged(listener: (state: ConnectionState) => void): IDisposable {
    return this.stateListeners.add(listener);
  }

  dispose(): void {
    if (this._state === 'disposed') return;
    this.clearTimer();
    const error = new CoreDisconnected(1000, 'LocalPilot client disposed');
    if (this.ws) this.dropSocket(this.ws, 1000, 'disposed');
    this.clearInitTimer();
    this.endpoint.rejectAll(error);
    this.endpoint.dispose();
    this.settleWaiters((w) => w.reject(error));
    this.queued.drain();
    this.setState('disposed');
    this.reconnectListeners.clear();
    this.statusListeners.clear();
    this.disconnectListeners.clear();
    this.stateListeners.clear();
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new this.server.WebSocket(this.url);
    } catch (e) {
      this.log(`cannot open ${this.url}: ${e instanceof Error ? e.message : String(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.opened = true;
      this.initialize(ws);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      // One message per frame; tolerate several newline-separated ones.
      for (const line of ev.data.split('\n')) {
        if (line.trim()) this.endpoint.receive(line);
      }
    };
    ws.onerror = () => undefined; // a close event always follows
    ws.onclose = (ev: CloseEvent) => this.handleClose(ws, ev.code, ev.reason);
  }

  private initialize(ws: WebSocket): void {
    const settings = coreInitSettings(this.options.settings());
    this.clearInitTimer();
    this.initTimer = setTimeout(() => {
      this.initTimer = undefined;
      if (this.ws !== ws) return;
      this.log(`initialize unanswered after ${this.initializeTimeoutMs} ms; reconnecting`);
      this.dropSocket(ws, 4408, 'initialize timed out');
      this.setState(this.everReady ? 'reconnecting' : 'connecting');
      this.scheduleReconnect();
    }, this.initializeTimeoutMs);
    this.endpoint.request<InitializeResult>('initialize', { settings }).then(
      (result) => {
        if (this.ws !== ws || this._state === 'disposed') return;
        this.clearInitTimer();
        const replay = this.everReady || this.replayPending;
        this.everReady = true;
        this.replayPending = false;
        this.attempt = 0;
        this._lastError = undefined;
        this._initializeResult = result;
        this._state = 'ready';
        for (const [method, params] of this.queued.drain()) this.notify(method, params);
        if (result.ollamaStatus) this.statusListeners.emit(result.ollamaStatus);
        if (replay) this.reconnectListeners.emit();
        this.settleWaiters((w) => w.resolve(result));
        this.stateListeners.emit('ready');
      },
      (raw: unknown) => {
        const err = toCoreDisconnected(raw);
        // A close rejects initialize too, and "core exited" precedes a close;
        // handleClose deals with both.
        if (this.ws !== ws || this._state === 'disposed' || err instanceof CoreDisconnected) return;
        this.clearInitTimer();
        // The server refused: its core is crashed or cannot start. Somebody may
        // restart it (another tab, a settings change, the server owner), and the
        // server closes no socket then, so keep asking on this one. What was
        // queued is dropped (it could grow without bound); the first ready replays.
        const first = this._state !== 'crashed';
        this._lastError = err instanceof Error ? err : new Error(String(err));
        if (first) this.log(`initialize refused: ${this._lastError.message}`);
        if (!this.everReady) this.replayPending = true;
        this.queued.drain();
        this.setState('crashed');
        const error = this._lastError;
        this.settleWaiters((w) => w.reject(error));
        this.scheduleReconnect();
      }
    );
  }

  private handleClose(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return;
    const wasOpen = this.opened;
    const error = this.detach(code, reason);
    if (this._state === 'disposed') return;
    if (wasOpen) this.disconnectListeners.emit(error);
    this.setState(this.everReady ? 'reconnecting' : 'connecting');
    this.scheduleReconnect();
  }

  /** Closes `ws` ourselves (its close event is then ignored). */
  private dropSocket(ws: WebSocket, code: number, reason: string): void {
    const wasOpen = this.opened;
    const error = this.detach(code, reason);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    if (wasOpen && this._state === 'ready') this.disconnectListeners.emit(error);
  }

  /** Forgets the current socket and fails what was pending on it. */
  private detach(code: number, reason: string): CoreDisconnected {
    this.ws = undefined;
    this.opened = false;
    this.clearInitTimer();
    const error = new CoreDisconnected(code, reason);
    this.endpoint.rejectAll(error);
    return error;
  }

  private settleWaiters(settle: (waiter: Waiter<InitializeResult>) => void): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const w of waiters) settle(w);
  }

  private clearInitTimer(): void {
    if (this.initTimer !== undefined) clearTimeout(this.initTimer);
    this.initTimer = undefined;
  }

  private scheduleReconnect(): void {
    this.clearTimer();
    const delay = Math.min(this.initialBackoffMs * 2 ** this.attempt, this.maxBackoffMs);
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this._state === 'crashed' && this.ws && this.opened) {
        this.initialize(this.ws);
      } else if (RETRY_STATES.includes(this._state)) {
        this.connect();
      }
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private sendLine(line: string): void {
    const ws = this.ws;
    if (!ws || !this.opened) throw new CoreDisconnected(1006, 'not connected');
    ws.send(line);
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    this.stateListeners.emit(state);
  }
}

function wrap(d: { dispose(): void }): IDisposable {
  let disposed = false;
  return {
    get isDisposed() {
      return disposed;
    },
    dispose() {
      disposed = true;
      d.dispose();
    }
  };
}
