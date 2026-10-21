import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { RpcEndpoint } from '@localpilot/rpc-client';
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
 * The WebSocket to the Jupyter server closed (`code` 1012: the server's core
 * restarted). Every request pending at that moment is rejected with it, and
 * `onDisconnect` listeners receive it; it is never an `RpcError`.
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined); // nobody may be waiting
  return { promise, resolve, reject };
}

function abortError(): Error {
  const err = new Error('request aborted');
  err.name = 'AbortError';
  return err;
}

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
 * - `notify()` before the first `ready` is queued and flushed right after
 *   `initialize`; while reconnecting it is dropped (`onReconnect` replays state).
 */
export class WsCoreClient implements IDisposable {
  readonly url: string;
  private readonly server: ServerConnection.ISettings;
  private readonly endpoint: RpcEndpoint;
  private readonly log: (message: string) => void;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  private _state: ConnectionState = 'idle';
  private ws?: WebSocket;
  private opened = false;
  private everReady = false;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private queued: Array<[string, unknown]> = [];
  private ready = deferred<InitializeResult>();
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
    if (!signal) return this.ready.promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<InitializeResult>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      this.ready.promise.then(
        (r) => {
          signal.removeEventListener('abort', onAbort);
          resolve(r);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        }
      );
    });
  }

  /**
   * Sends a request once the client is ready. Rejects with `CoreDisconnected`
   * if the socket closes before the answer, with an `RpcError` when the core
   * (or the server) answers with an error, and with an `AbortError` on `signal`.
   */
  async request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this._state !== 'ready') await this.whenReady(signal);
    return this.endpoint.request<T>(method, params, signal);
  }

  /** Fire-and-forget; see the class comment for what happens while not ready. */
  notify(method: string, params?: unknown): void {
    if (this._state === 'ready') {
      try {
        this.endpoint.notify(method, params);
      } catch (e) {
        this.log(`dropped ${method}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (!this.everReady && this._state !== 'disposed') {
      this.queued.push([method, params]);
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
   * Fires after every successful re-`initialize` (not the first): the server's
   * core may be new, with an empty overlay, so re-send `didOpen` for every
   * synced document here. Runs before waiting requests are released.
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
    this.endpoint.rejectAll(error);
    this.endpoint.dispose();
    this.ready.reject(error);
    this.queued = [];
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
    this.endpoint.request<InitializeResult>('initialize', { settings }).then(
      (result) => {
        if (this.ws !== ws || this._state === 'disposed') return;
        const reconnected = this.everReady;
        this.everReady = true;
        this.attempt = 0;
        this._lastError = undefined;
        this._initializeResult = result;
        this._state = 'ready';
        const queued = this.queued;
        this.queued = [];
        for (const [method, params] of queued) this.notify(method, params);
        if (result.ollamaStatus) this.statusListeners.emit(result.ollamaStatus);
        if (reconnected) this.reconnectListeners.emit();
        this.ready.resolve(result);
        this.stateListeners.emit('ready');
      },
      (err: unknown) => {
        // A close rejects initialize too; handleClose has dealt with that.
        if (this.ws !== ws || this._state === 'disposed' || err instanceof CoreDisconnected) return;
        // The server refused: its core is crashed or cannot start. Somebody may
        // restart it (another tab, a settings change, the server owner), and the
        // server closes no socket then, so keep asking on this one.
        const first = this._state !== 'crashed';
        this._lastError = err instanceof Error ? err : new Error(String(err));
        if (first) this.log(`initialize refused: ${this._lastError.message}`);
        const waiting = this.ready;
        this.ready = deferred();
        this.setState('crashed');
        waiting.reject(this._lastError);
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
    const error = new CoreDisconnected(code, reason);
    if (this._state === 'ready') this.ready = deferred();
    this.endpoint.rejectAll(error);
    return error;
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
