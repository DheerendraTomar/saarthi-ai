import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RpcEndpoint, RpcError, ErrorCodes, type Disposable } from "@localpilot/rpc-client";
import type { Settings } from "../settings";

export type CoreState = "stopped" | "starting" | "ready" | "crashed";
export type CoreLogLevel = "info" | "warn" | "error";

/** A launch command; the client appends `serve --workspace <root> --log-level <level>`. */
export interface CoreCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface CoreExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface CoreClientOptions {
  /** Path of the `localpilot-core` binary, or a full command (e.g. node + fakeCore.mjs). */
  binaryPath: string | CoreCommand;
  workspaceRoot: string;
  logLevel: string;
  onLog: (level: CoreLogLevel, message: string) => void;
  /** Automatic restarts allowed within any 60 s window (default 3). */
  maxRestartsPerMinute?: number;
  /** How long `stop()` waits for a clean exit before killing (default 2000 ms). */
  shutdownTimeoutMs?: number;
}

export interface InitializeResult {
  capabilities: { completion: boolean; chat: boolean; bench: boolean };
  ollamaStatus: { ollama: "ok" | "down" | "modelMissing"; detail: string };
  indexStatus: "building" | "ready";
}

/** Structural subset of `vscode.CancellationToken`. */
export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => unknown): Disposable;
}

/** Rejection for every request that was pending when the core process died. */
export class CoreCrashed extends Error {
  override name = "CoreCrashed";
  constructor(readonly exit: CoreExit) {
    super(`LocalPilot core exited unexpectedly (${describeExit(exit)})`);
  }
}

export type Event<T> = (listener: (e: T) => unknown) => Disposable;

/** A tiny `vscode.EventEmitter`-compatible emitter (`event`, `fire`, `dispose`). */
export class Emitter<T> {
  private listeners = new Set<(e: T) => unknown>();
  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

type NotificationHandler = (params: unknown) => void;
type RequestHandler = (params: unknown) => Promise<unknown>;

const RESTART_WINDOW_MS = 60_000;

function describeExit(exit: CoreExit): string {
  return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;
}

/** Splits a stream of text chunks into lines; a partial line waits for its newline. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      onLine(line);
    }
  };
}

interface Running {
  generation: number;
  child: ChildProcessWithoutNullStreams;
  endpoint: RpcEndpoint;
  registered: Set<string>;
  /** Resolves when the process has exited and its stdio is drained. */
  closed: Promise<CoreExit>;
}

/**
 * Owns the `localpilot-core serve` child process: newline-delimited JSON-RPC
 * over its stdio (via `RpcEndpoint`), restart-on-crash (at most
 * `maxRestartsPerMinute`, then `crashed`), and graceful `shutdown`.
 * Notification/request handlers survive restarts.
 */
export class CoreClient {
  private _state: CoreState = "stopped";
  private readonly stateEmitter = new Emitter<CoreState>();
  readonly onDidChangeState: Event<CoreState> = this.stateEmitter.event;

  private running?: Running;
  private generation = 0;
  private settings?: Settings;
  private ready?: Promise<InitializeResult>;
  private restarts: number[] = [];
  private queuedNotifications: Array<[string, unknown]> = [];
  private stopping?: Promise<CoreExit | undefined>;
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly requestHandlers = new Map<string, RequestHandler>();

  constructor(private readonly opts: CoreClientOptions) {}

  get state(): CoreState {
    return this._state;
  }

  /** Spawns the core and sends `initialize`; resolves with its result. */
  start(settings: Settings): Promise<InitializeResult> {
    this.settings = settings;
    if (this.running && this.ready && (this._state === "starting" || this._state === "ready")) {
      return this.ready;
    }
    this.restarts = [];
    return this.launch();
  }

  /** Stops the running core (if any) and starts a fresh one, optionally with new settings. */
  async restart(settings?: Settings): Promise<InitializeResult> {
    if (settings) this.settings = settings;
    if (!this.settings) throw new Error("CoreClient.restart() called before start()");
    await this.stop();
    this.restarts = [];
    return this.launch();
  }

  /**
   * Sends a request once the core is ready. Rejects immediately when the core
   * is not running, with `CoreCrashed` if it dies first, and with an
   * `AbortError` when `token` is cancelled.
   */
  async request<T>(method: string, params?: unknown, token?: CancellationTokenLike): Promise<T> {
    if (this._state === "starting" && this.ready) await this.ready;
    const running = this.running;
    if (!running || this._state !== "ready") {
      throw new Error(`LocalPilot core is not running (state: ${this._state})`);
    }
    if (!token) return running.endpoint.request<T>(method, params);
    const ctrl = new AbortController();
    if (token.isCancellationRequested) ctrl.abort();
    const sub = token.onCancellationRequested(() => ctrl.abort());
    try {
      return await running.endpoint.request<T>(method, params, ctrl.signal);
    } finally {
      sub.dispose();
    }
  }

  /** Sends a notification; queued while starting (the core drops pre-initialize ones), dropped when not running. */
  notify(method: string, params?: unknown): void {
    if (this._state === "ready" && this.running) {
      this.sendNotification(this.running.endpoint, method, params);
    } else if (this._state === "starting") {
      this.queuedNotifications.push([method, params]);
    }
  }

  onNotification(method: string, handler: (params: unknown) => void): Disposable {
    let set = this.notificationHandlers.get(method);
    if (!set) this.notificationHandlers.set(method, (set = new Set()));
    set.add(handler);
    if (this.running) this.register(this.running, method);
    return { dispose: () => set.delete(handler) };
  }

  /** Answers core→client requests (`workspace/applyEdit`, `workspace/runCommand`). */
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): Disposable {
    this.requestHandlers.set(method, handler);
    if (this.running) this.register(this.running, method);
    return {
      dispose: () => {
        if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
      },
    };
  }

  /**
   * Sends `shutdown`, closes stdin and waits up to `shutdownTimeoutMs` for the
   * process to exit, then kills it. Resolves with how it exited (undefined if
   * nothing was running).
   */
  stop(): Promise<CoreExit | undefined> {
    if (this.stopping) return this.stopping;
    const running = this.running;
    if (!running) {
      this.setState("stopped");
      return Promise.resolve(undefined);
    }
    const timeoutMs = this.opts.shutdownTimeoutMs ?? 2000;
    this.stopping = (async () => {
      const deadline = Date.now() + timeoutMs;
      const timer = (ms: number) => {
        let handle: ReturnType<typeof setTimeout> | undefined;
        const promise = new Promise<undefined>((r) => (handle = setTimeout(() => r(undefined), Math.max(0, ms))));
        return { promise, cancel: () => clearTimeout(handle) };
      };
      const t1 = timer(timeoutMs);
      await Promise.race([running.endpoint.request("shutdown").catch(() => undefined), running.closed, t1.promise]);
      t1.cancel();
      running.child.stdin.end();
      const t2 = timer(deadline - Date.now());
      let exit = await Promise.race([running.closed, t2.promise]);
      t2.cancel();
      if (!exit) {
        this.opts.onLog("warn", `LocalPilot core did not exit within ${timeoutMs} ms of shutdown; killing it`);
        running.child.kill("SIGKILL");
        exit = await running.closed;
      }
      return exit;
    })();
    return this.stopping;
  }

  private launch(): Promise<InitializeResult> {
    const settings = this.settings;
    if (!settings) throw new Error("no settings");
    const { workspaceRoot, logLevel, onLog } = this.opts;
    const base: CoreCommand =
      typeof this.opts.binaryPath === "string" ? { command: this.opts.binaryPath, args: [] } : this.opts.binaryPath;
    const generation = ++this.generation;
    this.queuedNotifications = [];
    this.setState("starting");

    const child = spawn(base.command, [...base.args, "serve", "--workspace", workspaceRoot, "--log-level", logLevel], {
      cwd: workspaceRoot,
      env: { ...process.env, ...base.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const endpoint = new RpcEndpoint(
      (line) => {
        if (!child.stdin.writable) throw new Error("LocalPilot core stdin is closed");
        child.stdin.write(line + "\n");
      },
      { onError: (m) => onLog("warn", m) },
    );

    let settle!: (exit: CoreExit) => void;
    const closed = new Promise<CoreExit>((r) => (settle = r));
    const running: Running = { generation, child, endpoint, registered: new Set(), closed };
    this.running = running;
    for (const m of this.notificationHandlers.keys()) this.register(running, m);
    for (const m of this.requestHandlers.keys()) this.register(running, m);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", lineSplitter((line) => endpoint.receive(line)));
    // Always drain stderr so a chatty core can never block on a full pipe.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", lineSplitter((line) => line.trim() && onLog("info", line)));
    child.stdin.on("error", () => {}); // EPIPE after the core died; the close handler deals with it.

    let exited = false;
    const onExit = (exit: CoreExit, spawnError?: Error) => {
      if (exited) return;
      exited = true;
      settle(exit);
      this.handleExit(running, exit, spawnError);
    };
    child.on("error", (err) => {
      if (child.pid === undefined) {
        // ENOENT / EACCES etc.: the binary cannot be launched, so retrying is pointless.
        onLog("error", `LocalPilot core could not be started (${base.command}): ${err.message}`);
        onExit({ code: null, signal: null }, err);
      } else {
        onLog("warn", `LocalPilot core process error: ${err.message}`);
      }
    });
    // `close` (not `exit`): fires after stdout is drained, so no response is lost.
    child.on("close", (code, signal) => onExit({ code, signal }));

    const ready = endpoint
      .request<InitializeResult>("initialize", { workspaceRoot, settings })
      .then((result) => {
        if (this.running === running && this._state === "starting") {
          this.setState("ready");
          const queued = this.queuedNotifications;
          this.queuedNotifications = [];
          for (const [method, params] of queued) this.sendNotification(endpoint, method, params);
        }
        return result;
      })
      .catch((err: unknown) => {
        if (err instanceof RpcError && this.running === running) {
          // The core is alive but refused to initialize: restarting would not help.
          onLog("error", `LocalPilot core refused initialize: ${err.message}`);
          this.setState("crashed");
          this.running = undefined;
          endpoint.dispose();
          child.kill();
        }
        throw err;
      });
    ready.catch(() => {}); // automatic restarts have no caller to observe the rejection
    this.ready = ready;
    return ready;
  }

  private handleExit(running: Running, exit: CoreExit, spawnError?: Error): void {
    if (this.running !== running) {
      running.endpoint.dispose();
      return;
    }
    this.running = undefined;
    this.queuedNotifications = [];
    if (this.stopping) {
      running.endpoint.rejectAll(new Error("LocalPilot core stopped"));
      running.endpoint.dispose();
      this.stopping = undefined;
      this.setState("stopped");
      return;
    }
    if (spawnError) {
      running.endpoint.rejectAll(spawnError);
      running.endpoint.dispose();
      this.setState("crashed");
      return;
    }
    running.endpoint.rejectAll(new CoreCrashed(exit));
    running.endpoint.dispose();
    const max = this.opts.maxRestartsPerMinute ?? 3;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= max) {
      this.setState("crashed");
      this.opts.onLog(
        "error",
        `LocalPilot core crashed (${describeExit(exit)}) after ${max} restarts within a minute; not restarting. ` +
          `See <workspace>/.localpilot/core.log, then run "LocalPilot: Restart Core".`,
      );
      return;
    }
    this.restarts.push(now);
    this.opts.onLog(
      "warn",
      `LocalPilot core exited unexpectedly (${describeExit(exit)}); restarting (${this.restarts.length}/${max} this minute)`,
    );
    void this.launch().catch(() => {});
  }

  /** Notifications are fire-and-forget: a dead pipe is logged, never thrown to the caller. */
  private sendNotification(endpoint: RpcEndpoint, method: string, params: unknown): void {
    try {
      endpoint.notify(method, params);
    } catch (e) {
      this.opts.onLog("warn", `dropped ${method} notification: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private register(running: Running, method: string): void {
    if (running.registered.has(method)) return;
    running.registered.add(method);
    if (this.notificationHandlers.has(method)) {
      running.endpoint.onNotification(method, (params) => this.dispatchNotification(method, params));
    }
    if (this.requestHandlers.has(method)) {
      running.endpoint.onRequest(method, (params) => {
        const handler = this.requestHandlers.get(method);
        if (!handler) throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
        return handler(params);
      });
    }
  }

  private dispatchNotification(method: string, params: unknown): void {
    for (const handler of [...(this.notificationHandlers.get(method) ?? [])]) {
      try {
        handler(params);
      } catch (e) {
        this.opts.onLog("error", `handler for ${method} threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private setState(state: CoreState): void {
    if (this._state === state) return;
    this._state = state;
    this.stateEmitter.fire(state);
  }
}
