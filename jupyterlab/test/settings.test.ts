import { readFileSync } from 'fs';
import { join } from 'path';
import { ServerConnection } from '@jupyterlab/services';
import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Signal } from '@lumino/signaling';
import schema from '../schema/plugin.json';
import {
  DEFAULT_SETTINGS,
  RESTART_DEBOUNCE_MS,
  coreInitSettings,
  fetchStatus,
  readSettings,
  restartCore,
  sameCoreSettings,
  watchSettings
} from '../src/settings';

/** The slice of ISettingRegistry.ISettings the module uses. */
class FakePluginSettings {
  readonly changed = new Signal<this, void>(this);
  constructor(public composite: Record<string, unknown>) {}
  set(values: Record<string, unknown>): void {
    this.composite = values;
    this.changed.emit();
  }
}

const asSettings = (s: FakePluginSettings) => s as unknown as ISettingRegistry.ISettings;

describe('settings', () => {
  it('schema has the VS Code keys and defaults', () => {
    const defaults = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, (v as { default: unknown }).default])
    );
    expect(defaults).toEqual({ ...DEFAULT_SETTINGS });
    expect(DEFAULT_SETTINGS).toEqual({
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
    // Same defaults as the VS Code extension's localpilot.* settings.
    const vscode = JSON.parse(readFileSync(join(__dirname, '..', '..', 'vscode', 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default: unknown }> } };
    };
    expect(vscode.contributes.configuration.properties['localpilot.adaptiveCompletions'].default).toBe(true);
  });

  it('adaptiveCompletions is forwarded to the core and restarts it', () => {
    const s = readSettings(asSettings(new FakePluginSettings({ adaptiveCompletions: false })));
    expect(s.adaptiveCompletions).toBe(false);
    expect(coreInitSettings(s).adaptiveCompletions).toBe(false);
    expect(sameCoreSettings(s, { ...s, adaptiveCompletions: true })).toBe(false);
  });

  it('reads the composite settings over the defaults', () => {
    const s = readSettings(asSettings(new FakePluginSettings({ chatModel: 'm', bogus: 1 })));
    expect(s).toEqual({ ...DEFAULT_SETTINGS, chatModel: 'm' });
  });

  it('always sends completionsEnabled: true to the core', () => {
    expect(coreInitSettings({ ...DEFAULT_SETTINGS, completionsEnabled: false }).completionsEnabled).toBe(true);
  });

  it('fetchStatus GETs /localpilot/status with the root dir', async () => {
    const body = { core: 'stopped', ollama: null, rootDir: '/srv/nb' };
    const fetch = jest.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const server = ServerConnection.makeSettings({
      baseUrl: 'http://localhost:8888/base/',
      fetch: fetch as unknown as typeof window.fetch
    });
    expect(await fetchStatus(server)).toEqual(body);
    const [req] = fetch.mock.calls[0] as unknown as [Request];
    expect(req.url.split('?')[0]).toBe('http://localhost:8888/base/localpilot/status');
    expect(req.method).toBe('GET');
  });

  it('restartCore POSTs the core settings to /localpilot/restart', async () => {
    const fetch = jest.fn(async () => new Response(JSON.stringify({ core: 'ready', ollama: null }), { status: 200 }));
    const server = ServerConnection.makeSettings({
      baseUrl: 'http://localhost:8888/base/',
      fetch: fetch as unknown as typeof window.fetch,
      token: 'tok',
      appendToken: true
    });
    document.cookie = '_xsrf=xsrf-value';
    const status = await restartCore(server, { ...DEFAULT_SETTINGS, completionsEnabled: false });
    expect(status).toEqual({ core: 'ready', ollama: null });
    const [req] = fetch.mock.calls[0] as unknown as [Request];
    expect(req.url.split('?')[0]).toBe('http://localhost:8888/base/localpilot/restart');
    expect(req.method).toBe('POST');
    expect(req.headers.get('Authorization')).toBe('token tok');
    expect(req.headers.get('X-XSRFToken')).toBe('xsrf-value');
    expect(JSON.parse(await req.text())).toEqual({ settings: { ...DEFAULT_SETTINGS, completionsEnabled: true } });
  });

  it('restarts the core once edits settle, but not for client-only settings', async () => {
    jest.useFakeTimers();
    try {
      const plugin = new FakePluginSettings({});
      const restart = jest.fn(async () => undefined);
      const changes: boolean[] = [];
      const watcher = watchSettings(asSettings(plugin), {
        onChange: (s) => changes.push(s.completionsEnabled),
        restart
      });

      plugin.set({ completionsEnabled: false, completionDebounceMs: 300 });
      await jest.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS * 2);
      expect(changes).toEqual([false]);
      expect(restart).not.toHaveBeenCalled();

      plugin.set({ completionsEnabled: false, chatModel: 'a' });
      plugin.set({ completionsEnabled: false, chatModel: 'b' });
      await jest.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS - 1);
      expect(restart).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(restart).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, completionsEnabled: false, chatModel: 'b' });

      watcher.dispose();
      plugin.set({ chatModel: 'c' });
      await jest.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS * 2);
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
