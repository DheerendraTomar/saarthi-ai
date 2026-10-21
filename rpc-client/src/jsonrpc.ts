/**
 * Transport-agnostic JSON-RPC 2.0 over newline-delimited JSON.
 *
 * `RpcEndpoint` owns request ids, the pending-response map and method
 * dispatch; the transport only moves lines: it hands every received line to
 * `receive()` and writes what the endpoint passes to `send` (one message per
 * line, the transport adds the newline). The VS Code extension composes it
 * with a child process's stdio; the JupyterLab client with a WebSocket.
 *
 * Ids: this side numbers its requests 1, 2, 3, …; the LocalPilot core numbers
 * its core→client requests -1, -2, … so the two never collide.
 */

export type Id = number | string;

export interface RequestMessage {
  jsonrpc: "2.0";
  id: Id;
  method: string;
  params?: unknown;
}

export interface NotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface ErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface ResponseMessage {
  jsonrpc: "2.0";
  id: Id | null;
  result?: unknown;
  error?: ErrorObject;
}

export type Message = RequestMessage | NotificationMessage | ResponseMessage;

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** An error response from the peer, or one a request handler wants to send. */
export class RpcError extends Error {
  override name = "RpcError";
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface Disposable {
  dispose(): void;
}

/** One message as one line. JSON.stringify escapes every newline inside strings. */
export function encode(msg: Message): string {
  return JSON.stringify(msg);
}

/** Parses one line; returns null for blank lines, bad JSON or non-JSON-RPC objects. */
export function decode(line: string): Message | null {
  const text = line.trim();
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (m.jsonrpc !== "2.0") return null;
  if (typeof m.method === "string") return m as unknown as Message;
  if ("id" in m && ("result" in m || "error" in m)) return m as unknown as Message;
  return null;
}

/** Requests the core sends to the client carry negative ids. */
export function isServerRequestId(id: Id | null | undefined): boolean {
  return typeof id === "number" && id < 0;
}

function abortError(): Error {
  const err = new Error("request aborted");
  err.name = "AbortError";
  return err;
}

export interface Resolver<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** Outstanding requests by id, each optionally failing after a timeout. */
export class PendingMap {
  private readonly entries = new Map<Id, { resolver: Resolver; timer?: ReturnType<typeof setTimeout> }>();

  get size(): number {
    return this.entries.size;
  }

  has(id: Id): boolean {
    return this.entries.has(id);
  }

  /** Registers `id`; if `timeoutMs` is given the entry rejects with a TimeoutError. */
  add(id: Id, resolver: Resolver, timeoutMs?: number): void {
    const entry: { resolver: Resolver; timer?: ReturnType<typeof setTimeout> } = { resolver };
    if (timeoutMs !== undefined) {
      entry.timer = setTimeout(() => {
        const err = new Error(`request ${String(id)} timed out after ${timeoutMs} ms`);
        err.name = "TimeoutError";
        this.reject(id, err);
      }, timeoutMs);
    }
    this.entries.set(id, entry);
  }

  /** Removes `id` and resolves it; false if it was not pending. */
  resolve(id: Id, value: unknown): boolean {
    const entry = this.take(id);
    entry?.resolver.resolve(value);
    return entry !== undefined;
  }

  /** Removes `id` and rejects it; false if it was not pending. */
  reject(id: Id, error: unknown): boolean {
    const entry = this.take(id);
    entry?.resolver.reject(error);
    return entry !== undefined;
  }

  /** Removes `id` without settling it. */
  delete(id: Id): boolean {
    return this.take(id) !== undefined;
  }

  rejectAll(error: unknown): void {
    for (const id of [...this.entries.keys()]) this.reject(id, error);
  }

  private take(id: Id) {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    return entry;
  }
}

export type NotificationHandler = (params: unknown) => void;
export type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

export interface RpcEndpointOptions {
  /** Fail every request that has no response after this many ms (default: never). */
  requestTimeoutMs?: number;
  /** Called with lines that are not valid JSON-RPC and with handler failures. */
  onError?: (message: string) => void;
}

export class RpcEndpoint {
  private nextId = 1;
  private readonly pending = new PendingMap();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private disposed = false;

  constructor(
    private readonly send: (line: string) => void,
    private readonly options: RpcEndpointOptions = {},
  ) {}

  /** Feeds one received line (without its newline) into the endpoint. */
  receive(line: string): void {
    if (this.disposed) return;
    const msg = decode(line);
    if (!msg) {
      if (line.trim()) this.options.onError?.(`invalid JSON-RPC line: ${line.slice(0, 200)}`);
      return;
    }
    if ("method" in msg) {
      if ("id" in msg && msg.id !== undefined && msg.id !== null) {
        void this.handleRequest(msg as RequestMessage);
      } else {
        this.handleNotification(msg);
      }
      return;
    }
    const res = msg as ResponseMessage;
    if (res.id === null) {
      this.options.onError?.(`error response without id: ${res.error?.message ?? ""}`);
      return;
    }
    if (res.error) {
      this.pending.reject(res.id, new RpcError(res.error.code, res.error.message, res.error.data));
    } else {
      this.pending.resolve(res.id, res.result);
    }
  }

  request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("RPC endpoint disposed"));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => this.pending.reject(id, abortError());
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      this.pending.add(
        id,
        {
          resolve: (v) => {
            cleanup();
            resolve(v as T);
          },
          reject: (e) => {
            cleanup();
            reject(e);
          },
        },
        this.options.requestTimeoutMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.send(encode(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        this.pending.reject(id, e);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    this.send(encode(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params }));
  }

  /** Several handlers may listen to one method; they run in registration order. */
  onNotification(method: string, handler: NotificationHandler): Disposable {
    let set = this.notificationHandlers.get(method);
    if (!set) this.notificationHandlers.set(method, (set = new Set()));
    set.add(handler);
    return { dispose: () => set.delete(handler) };
  }

  /** One handler per method (a later registration replaces the earlier one). */
  onRequest(method: string, handler: RequestHandler): Disposable {
    this.requestHandlers.set(method, handler);
    return {
      dispose: () => {
        if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
      },
    };
  }

  /** Rejects every pending request with `error`; the endpoint stays usable. */
  rejectAll(error: unknown): void {
    this.pending.rejectAll(error);
  }

  /** Rejects pending requests, drops handlers and ignores all further traffic. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.rejectAll(new Error("RPC endpoint disposed"));
    this.notificationHandlers.clear();
    this.requestHandlers.clear();
  }

  private handleNotification(msg: NotificationMessage): void {
    const handlers = this.notificationHandlers.get(msg.method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(msg.params);
      } catch (e) {
        this.options.onError?.(`notification handler for ${msg.method} threw: ${String(e)}`);
      }
    }
  }

  private async handleRequest(msg: RequestMessage): Promise<void> {
    const handler = this.requestHandlers.get(msg.method);
    let response: ResponseMessage;
    if (!handler) {
      response = {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: ErrorCodes.MethodNotFound, message: `method not found: ${msg.method}` },
      };
    } else {
      try {
        const result = await handler(msg.params);
        response = { jsonrpc: "2.0", id: msg.id, result: result ?? null };
      } catch (e) {
        const error: ErrorObject =
          e instanceof RpcError
            ? { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) }
            : { code: ErrorCodes.InternalError, message: e instanceof Error ? e.message : String(e) };
        response = { jsonrpc: "2.0", id: msg.id, error };
      }
    }
    if (this.disposed) return;
    try {
      this.send(encode(response));
    } catch (e) {
      this.options.onError?.(`failed to answer ${msg.method}: ${String(e)}`);
    }
  }
}
