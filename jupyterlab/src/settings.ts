import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import type { IDisposable } from '@lumino/disposable';

/** Settings-registry id of the plugin; schema/plugin.json holds the schema. */
export const PLUGIN_ID = 'localpilot-jupyter:plugin';

/**
 * LocalPilot settings: the same keys and defaults as VS Code's `localpilot.*`
 * (spec §4.4), sent as `initialize.settings`. The core reads settings only at
 * `initialize`, so a change goes through `POST /localpilot/restart`.
 * Exceptions, as in VS Code: `completionsEnabled` is always sent as true
 * (`coreInitSettings`; the inline provider gates completions itself) and,
 * with `completionDebounceMs`, is client-only, so changing just those does not
 * restart the core. `coreBinaryPath` and `logLevel` are kept for parity but the
 * Jupyter server decides how to launch the core (`c.LocalPilot.*`).
 */
export interface Settings {
  ollamaUrl: string;
  completionModel: string;
  chatModel: string;
  completionsEnabled: boolean;
  completionDebounceMs: number;
  completionMaxTokens: number;
  chatThinking: 'off' | 'on';
  coreBinaryPath: string;
  allowedCommandsAlways: string[];
  completionContextTokens: number;
  chatContextTokens: number;
  logLevel: string;
  /** Let the core adapt completion length and style examples to the user's accept/reject outcomes. */
  adaptiveCompletions: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  ollamaUrl: 'http://localhost:11434',
  completionModel: 'qwen2.5-coder:0.5b-base',
  chatModel: 'qwen3.8:27b-mlx',
  completionsEnabled: true,
  completionDebounceMs: 120,
  completionMaxTokens: 32,
  chatThinking: 'off',
  coreBinaryPath: '',
  allowedCommandsAlways: [],
  completionContextTokens: 3584,
  chatContextTokens: 24000,
  logLevel: 'info',
  adaptiveCompletions: true
});

/** Wait for edits to settle before restarting the core (VS Code uses the same). */
export const RESTART_DEBOUNCE_MS = 500;

const CLIENT_ONLY_SETTINGS: ReadonlyArray<keyof Settings> = ['completionsEnabled', 'completionDebounceMs'];

/** The plugin's settings (`registry.load(PLUGIN_ID)`) as `Settings`, defaults filled in, unknown keys dropped. */
export function readSettings(pluginSettings: Pick<ISettingRegistry.ISettings, 'composite'>): Settings {
  const composite = (pluginSettings.composite ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_SETTINGS } as Record<keyof Settings, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    const value = composite[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out as unknown as Settings;
}

/** The settings sent to the core: completions always on (gated client-side). */
export function coreInitSettings(s: Settings): Settings {
  return { ...s, completionsEnabled: true };
}

/** True when `a` and `b` differ only in client-only settings. */
export function sameCoreSettings(a: Settings, b: Settings): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Array<keyof Settings>);
  for (const k of keys) {
    if (CLIENT_ONLY_SETTINGS.includes(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

/** `GET /localpilot/status` and `POST /localpilot/restart` answer with this. */
export interface ServerStatus {
  core: 'stopped' | 'starting' | 'ready' | 'crashed';
  ollama: { ollama: 'ok' | 'down' | 'modelMissing'; detail: string } | null;
  /** The Jupyter server's `root_dir`, absolute: the core's workspace. */
  rootDir?: string;
  error?: string;
}

/** `GET /localpilot/status`. Rejects with a `ResponseError` on a non-2xx answer. */
/** `GET /localpilot/ollama-command`: the line that starts Ollama in the no-network sandbox, or why not. */
export async function fetchOllamaCommand(server: ServerConnection.ISettings): Promise<{ command?: string; error?: string }> {
  const url = URLExt.join(server.baseUrl, 'localpilot', 'ollama-command');
  const response = await ServerConnection.makeRequest(url, { method: 'GET' }, server);
  if (!response.ok) {
    throw await ServerConnection.ResponseError.create(response);
  }
  return (await response.json()) as { command?: string; error?: string };
}

export async function fetchStatus(server: ServerConnection.ISettings): Promise<ServerStatus> {
  const url = URLExt.join(server.baseUrl, 'localpilot', 'status');
  const response = await ServerConnection.makeRequest(url, { method: 'GET' }, server);
  if (!response.ok) {
    throw await ServerConnection.ResponseError.create(response);
  }
  return (await response.json()) as ServerStatus;
}

/**
 * `POST /localpilot/restart` with the core settings (or without, to restart
 * with the stored ones). Goes through `ServerConnection.makeRequest`, so the
 * token and XSRF header are handled like every other Jupyter request.
 * The server closes every LocalPilot socket (1012) when a running core exits;
 * `WsCoreClient` reconnects on its own. Rejects with a `ResponseError` when
 * the server answers non-2xx (e.g. 500 when the core cannot start).
 */
export async function restartCore(server: ServerConnection.ISettings, settings?: Settings): Promise<ServerStatus> {
  const url = URLExt.join(server.baseUrl, 'localpilot', 'restart');
  const body = settings ? { settings: coreInitSettings(settings) } : {};
  const response = await ServerConnection.makeRequest(url, { method: 'POST', body: JSON.stringify(body) }, server);
  if (!response.ok) {
    throw await ServerConnection.ResponseError.create(response);
  }
  return (await response.json()) as ServerStatus;
}

export interface WatchSettingsOptions {
  /** Every change, after it is read (update client-side gates here). */
  onChange?: (settings: Settings) => void;
  /** Restarts the core with these settings (normally `restartCore`). */
  restart: (settings: Settings) => Promise<unknown>;
  /** Defaults to `RESTART_DEBOUNCE_MS`. */
  debounceMs?: number;
  /** Logs a failed restart; defaults to console.error. */
  onError?: (error: unknown) => void;
}

/**
 * Follows the plugin settings: calls `onChange` on every change and, once the
 * edits settle, `restart` — unless only client-only settings changed (a
 * restart would end a streaming chat reply for nothing).
 */
export function watchSettings(
  pluginSettings: Pick<ISettingRegistry.ISettings, 'composite' | 'changed'>,
  options: WatchSettingsOptions
): IDisposable {
  let coreSettings = readSettings(pluginSettings);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const onError = options.onError ?? ((e: unknown) => console.error('LocalPilot: core restart failed', e));

  const changed = () => {
    const settings = readSettings(pluginSettings);
    options.onChange?.(settings);
    clearTimeout(timer);
    timer = undefined;
    if (sameCoreSettings(coreSettings, settings)) return;
    timer = setTimeout(() => {
      timer = undefined;
      coreSettings = settings;
      options.restart(settings).catch(onError);
    }, options.debounceMs ?? RESTART_DEBOUNCE_MS);
  };
  pluginSettings.changed.connect(changed);

  return {
    get isDisposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      pluginSettings.changed.disconnect(changed);
    }
  };
}
