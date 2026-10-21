import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStatusBar } from '@jupyterlab/statusbar';
import { DisposableDelegate, DisposableSet } from '@lumino/disposable';
import { WsCoreClient } from './client';
import { PLUGIN_ID, readSettings, restartCore, watchSettings, type Settings } from './settings';
import { StatusItem } from './status';

export { CoreDisconnected, WsCoreClient, rpcUrl } from './client';
export type { ConnectionState, InitializeResult, OllamaStatus, WsCoreClientOptions } from './client';
export * from './settings';
export { StatusItem } from './status';

/**
 * LocalPilot: one `WsCoreClient` per JupyterLab tab, talking to the core the
 * Jupyter server extension owns; settings from the registry (a change restarts
 * the core); a status-bar item. Document sync (Task 3), the inline completion
 * provider (Task 4) and the chat sidebar and commands (Task 5) hang off the
 * client created here.
 */
/** Everything the plugin set up; disposed on `deactivate` and on page unload. */
let active: DisposableSet | undefined;

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'LocalPilot: local Ollama-backed inline completions and agent chat.',
  autoStart: true,
  requires: [ISettingRegistry],
  optional: [IStatusBar],
  activate: async (app: JupyterFrontEnd, registry: ISettingRegistry, statusBar: IStatusBar | null) => {
    const serverSettings = app.serviceManager.serverSettings;
    const pluginSettings = await registry.load(PLUGIN_ID);
    let settings: Settings = readSettings(pluginSettings);

    active?.dispose();
    const disposables = (active = new DisposableSet());

    const client = new WsCoreClient({ serverSettings, settings: () => settings });
    const status = new StatusItem();
    status.setCompletionsEnabled(settings.completionsEnabled);
    // Disposed in reverse order: subscriptions first, the client and status item last.
    disposables.add(status);
    disposables.add(client);
    disposables.add(client.onStatus((s) => status.setStatus(s)));
    disposables.add(client.onStateChanged((state) => status.setConnectionState(state, client.lastError?.message)));

    const watcher = watchSettings(pluginSettings, {
      onChange: (s) => {
        settings = s;
        status.setCompletionsEnabled(s.completionsEnabled);
      },
      restart: async (s) => {
        try {
          await restartCore(serverSettings, s);
        } finally {
          // A running core's exit closes our socket (1012) and the client
          // reconnects by itself; a crashed one never had a socket to close.
          if (client.state === 'crashed') client.reconnect();
        }
      }
    });
    disposables.add(watcher);

    const statusRegistration = statusBar?.registerStatusItem(`${PLUGIN_ID}:status`, {
      item: status,
      align: 'right',
      rank: 100
    });
    if (statusRegistration) disposables.add(statusRegistration);

    // Close the socket cleanly when the tab goes away (the server then releases this tab's documents).
    const onUnload = () => disposables.dispose();
    window.addEventListener('beforeunload', onUnload);
    disposables.add(new DisposableDelegate(() => window.removeEventListener('beforeunload', onUnload)));

    client.start();
  },
  deactivate: () => {
    active?.dispose();
    active = undefined;
  }
};

export default plugin;
