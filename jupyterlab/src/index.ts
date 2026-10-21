import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICompletionProviderManager } from '@jupyterlab/completer';
import { IEditorTracker } from '@jupyterlab/fileeditor';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStatusBar } from '@jupyterlab/statusbar';
import { DisposableSet } from '@lumino/disposable';
import { WsCoreClient } from './client';
import { DocumentSync } from './documentSync';
import { LocalPilotInlineProvider } from './inlineProvider';
import { PLUGIN_ID, fetchStatus, readSettings, restartCore, watchSettings, type Settings } from './settings';
import { StatusItem } from './status';

export { CoreDisconnected, WsCoreClient, rpcUrl } from './client';
export type { ConnectionState, InitializeResult, OllamaStatus, WsCoreClientOptions } from './client';
export * from './cellUri';
export { CONCAT_DEBOUNCE_MS, DocumentSync } from './documentSync';
export type { DocumentSyncOptions, SyncClient, SyncNotebookPanel } from './documentSync';
export { DEFAULT_TIMEOUT_MS, LocalPilotInlineProvider } from './inlineProvider';
export type { InlineClient, InlineProviderOptions, InlineSync } from './inlineProvider';
export * from './settings';
export { StatusItem } from './status';

/**
 * LocalPilot: one `WsCoreClient` per JupyterLab tab, talking to the core the
 * Jupyter server extension owns; settings from the registry (a change restarts
 * the core); a status-bar item. Document sync (Task 3), the inline completion
 * provider (Task 4) and the chat sidebar and commands (Task 5) hang off the
 * client created here.
 */
/** Everything the plugin set up; disposed on `deactivate`. */
let active: DisposableSet | undefined;
/**
 * The inline provider, registered once per completion manager (which cannot
 * unregister it) and attached to each activation.
 */
let inlineProvider: { provider: LocalPilotInlineProvider; manager: ICompletionProviderManager } | undefined;

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'LocalPilot: local Ollama-backed inline completions and agent chat.',
  autoStart: true,
  requires: [ISettingRegistry],
  optional: [IStatusBar, INotebookTracker, IEditorTracker, ICompletionProviderManager],
  activate: async (
    app: JupyterFrontEnd,
    registry: ISettingRegistry,
    statusBar: IStatusBar | null,
    notebookTracker: INotebookTracker | null,
    editorTracker: IEditorTracker | null,
    completionManager: ICompletionProviderManager | null
  ) => {
    const serverSettings = app.serviceManager.serverSettings;
    const pluginSettings = await registry.load(PLUGIN_ID);
    let settings: Settings = readSettings(pluginSettings);

    active?.dispose();
    // Lumino's DisposableSet disposes in insertion order: subscriptions, the
    // watcher and the status-bar registration go in first, the client and the
    // status item last.
    const disposables = (active = new DisposableSet());

    const client = new WsCoreClient({ serverSettings, settings: () => settings });
    const status = new StatusItem();
    status.setCompletionsEnabled(settings.completionsEnabled);
    disposables.add(client.onStatus((s) => status.setStatus(s)));
    disposables.add(client.onStateChanged((state) => status.setConnectionState(state, client.lastError?.message)));

    disposables.add(
      watchSettings(pluginSettings, {
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
      })
    );

    const statusRegistration = statusBar?.registerStatusItem(`${PLUGIN_ID}:status`, {
      item: status,
      align: 'right',
      rank: 100
    });
    if (statusRegistration) disposables.add(statusRegistration);

    // Notebook cells and file editors mirrored into the core's overlay, as
    // `file://<root_dir>/<path>` (cells as virtual files). Re-opened by the
    // sync itself after each reconnect; the first didOpens are queued.
    const rootDir = fetchStatus(serverSettings).then((s) => {
      if (!s.rootDir) throw new Error('the server did not report rootDir');
      return s.rootDir;
    });
    rootDir.catch((e) => console.error('LocalPilot: document sync disabled', e));
    const sync = new DocumentSync(client, notebookTracker, editorTracker, { rootDir });
    disposables.add(sync);

    // Ghost-text completions through JupyterLab's inline completer (listed in
    // its settings as "LocalPilot provider", enabled by default). Detached on
    // deactivate (it then answers nothing) and re-attached on the next activate.
    if (completionManager) {
      if (inlineProvider?.manager !== completionManager) {
        inlineProvider = { provider: new LocalPilotInlineProvider(), manager: completionManager };
        completionManager.registerInlineProvider(inlineProvider.provider);
      }
      disposables.add(inlineProvider.provider.attach({ client, sync, settings: () => settings }));
    }

    // No beforeunload disposal: it fires before the user can choose "Stay"
    // (JupyterLab prompts on unsaved work). On a real unload the browser closes
    // the socket and the server's tab-close cleanup releases this tab's state.
    disposables.add(client);
    disposables.add(status);

    client.start();
  },
  deactivate: () => {
    active?.dispose();
    active = undefined;
  }
};

export default plugin;
