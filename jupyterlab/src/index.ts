import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { Clipboard, Dialog, ICommandPalette, IThemeManager, InputDialog, Notification, showDialog } from '@jupyterlab/apputils';
import type { CodeEditor } from '@jupyterlab/codeeditor';
import { ICompletionProviderManager } from '@jupyterlab/completer';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IEditorTracker } from '@jupyterlab/fileeditor';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStatusBar } from '@jupyterlab/statusbar';
import { LabIcon } from '@jupyterlab/ui-components';
import { DisposableSet } from '@lumino/disposable';
import { Menu, Widget } from '@lumino/widgets';
import { applyEdit, type ApplyEditParams, type EditNotebook } from './chat/applyEdit';
import chatHtml from './chat/chat-ui.txt';
import { ChatWidget, type ActiveFile } from './chat/chatWidget';
import { jupyterThemeVars } from './chat/theme';
import { WsCoreClient } from './client';
import { COMMANDS, checkStatus, registerCommands, startOllama, type CommandDeps } from './commands';
import { DocumentSync } from './documentSync';
import { LocalPilotInlineProvider } from './inlineProvider';
import { unreachableStatus, watchUnreachable } from './reachability';
import { PLUGIN_ID, fetchOllamaCommand, fetchStatus, readSettings, restartCore, watchSettings, type Settings } from './settings';
import { StatusItem } from './status';

export { CoreDisconnected, ServerUnreachable, WsCoreClient, rpcUrl } from './client';
export { UNREACHABLE_MESSAGE, unreachableStatus, watchUnreachable } from './reachability';
export type { ConnectionState, InitializeResult, OllamaStatus, WsCoreClientOptions } from './client';
export * from './cellUri';
export { applyEdit } from './chat/applyEdit';
export type { ApplyEditOptions, ApplyEditParams, ApplyEditResult, EditOp } from './chat/applyEdit';
export { CHAT_WIDGET_ID, ChatWidget, IFRAME_SANDBOX, SESSIONS_CHANGED } from './chat/chatWidget';
export type { ActiveFile, ChatClient, ChatWidgetDeps } from './chat/chatWidget';
export { COMMANDS, OPEN_CHAT_KEYS } from './commands';
export { CONCAT_DEBOUNCE_MS, DocumentSync } from './documentSync';
export type { DocumentSyncOptions, SyncClient, SyncNotebookPanel } from './documentSync';
export { DEFAULT_TIMEOUT_MS, LocalPilotInlineProvider, OUTCOME_IDLE_MS } from './inlineProvider';
export type { InlineClient, InlineProviderOptions, InlineSync } from './inlineProvider';
export * from './settings';
export { StatusItem } from './status';

/**
 * LocalPilot: one `WsCoreClient` per JupyterLab tab, talking to the core the
 * Jupyter server extension owns; settings from the registry (a change restarts
 * the core); a status-bar item with the command menu; document sync; the
 * inline completion provider; the chat sidebar (which applies approved edits)
 * and the `localpilot:*` commands.
 */

/** The chat sidebar's tab icon (a speech bubble). */
const chatIcon = new LabIcon({
  name: 'localpilot:chat',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16"><path class="jp-icon3" fill="#616161" d="M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3 6v2h2V9H7zm4 0v2h2V9h-2zm4 0v2h2V9h-2z"/></svg>'
});

/** A CodeMirror selection (`column`) as an LSP range (`character`; both UTF-16). */
function selectionOf(editor: CodeEditor.IEditor | null | undefined): ActiveFile['selection'] {
  if (!editor) return undefined;
  const s = editor.getSelection();
  return { start: { line: s.start.line, character: s.start.column }, end: { line: s.end.line, character: s.end.column } };
}

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
  optional: [
    IStatusBar,
    INotebookTracker,
    IEditorTracker,
    ICompletionProviderManager,
    IDocumentManager,
    ICommandPalette,
    IThemeManager
  ],
  activate: async (
    app: JupyterFrontEnd,
    registry: ISettingRegistry,
    statusBar: IStatusBar | null,
    notebookTracker: INotebookTracker | null,
    editorTracker: IEditorTracker | null,
    completionManager: ICompletionProviderManager | null,
    docManager: IDocumentManager | null,
    palette: ICommandPalette | null,
    themeManager: IThemeManager | null
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
    disposables.add(client.onStateChanged((state) => status.setConnectionState(state, client.lastError?.message)));
    // Never reachable (server extension not loaded, wrong env, 403/404): say so
    // once, with a Retry, instead of "connecting" forever.
    disposables.add(
      watchUnreachable(client, {
        show: (message, retry) =>
          Notification.error(message, { autoClose: false, actions: [{ label: 'Retry', callback: () => retry() }] }),
        dismiss: (id) => Notification.dismiss(id)
      })
    );

    /**
     * Writes one LocalPilot setting to the registry: the watcher above picks
     * it up (restarting the core for a core setting). Read back with
     * `readSettings(pluginSettings)`, which is current as soon as `set` resolves.
     */
    const setSetting = async (key: keyof Settings, value: unknown) => {
      await pluginSettings.set(key, value as Parameters<typeof pluginSettings.set>[1]);
    };

    /** Restarts the core (with `s`, else the server's current settings). */
    const restart = async (s?: Settings) => {
      try {
        await restartCore(serverSettings, s);
      } finally {
        // A running core's exit closes our socket (1012) and the client
        // reconnects by itself; a crashed one never had a socket to close,
        // and an unreachable one retries only when asked.
        if (client.state === 'crashed' || client.state === 'error') client.reconnect();
      }
    };

    disposables.add(
      watchSettings(pluginSettings, {
        onChange: (s) => {
          settings = s;
          status.setCompletionsEnabled(s.completionsEnabled);
          // The toggle's label and checkmark read the settings.
          if (app.commands.hasCommand(COMMANDS.toggleCompletions)) app.commands.notifyCommandChanged(COMMANDS.toggleCompletions);
        },
        restart
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
    rootDir.catch((e) => {
      console.error('LocalPilot: document sync disabled', e);
      // 404: the server extension is not loaded; 403: not allowed. The socket
      // would only ever fail too, so stop waiting for it.
      const code = unreachableStatus(e);
      if (code !== undefined) client.markUnreachable(`GET /localpilot/status answered ${code}`);
    });
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

    // The chat sidebar: the chat-ui bundle in a sandboxed iframe, relayed to
    // the core. "Active file" and "insert at cursor" follow the main area's
    // current notebook cell / file editor.
    const currentEditor = (): { editor: CodeEditor.IEditor | null; uri: string | undefined } | undefined => {
      const current = app.shell.currentWidget;
      const panel = notebookTracker?.currentWidget;
      if (panel && current === panel) {
        const cell = notebookTracker?.activeCell;
        return cell ? { editor: cell.editor, uri: sync.uriForCell(cell.model) } : undefined;
      }
      const fileWidget = editorTracker?.currentWidget;
      if (fileWidget && current === fileWidget) {
        return { editor: fileWidget.content.editor, uri: sync.uriForFile(fileWidget.context) };
      }
      return undefined;
    };
    const chat = new ChatWidget(client, {
      html: () => chatHtml,
      activeFile: () => {
        const target = currentEditor();
        return target?.uri ? { uri: target.uri, selection: selectionOf(target.editor) } : undefined;
      },
      isSyncedUri: (uri) => sync.isSynced(uri),
      insertAtCursor: (text) => {
        const editor = currentEditor()?.editor;
        if (!editor?.replaceSelection) return false;
        editor.replaceSelection(text);
        editor.focus();
        return true;
      },
      copy: (text) => Clipboard.copyToSystem(text),
      startOllama: () => void startOllama(commandDeps),
      // The core pauses completions while chat generates (spec §5(10)); show it.
      onChatActiveChanged: (on) => status.setChatActive(on),
      // JupyterLab's --jp-* theme values under chat-ui's --vscode-* names.
      themeVars: () => {
        const style = getComputedStyle(document.body);
        return jupyterThemeVars((name) => style.getPropertyValue(name));
      },
      // The chat panel's model pickers and Settings panel.
      settings: () => readSettings(pluginSettings),
      setSetting
    });
    chat.title.icon = chatIcon;
    app.shell.add(chat, 'right', { rank: 1000 });
    disposables.add(chat);
    disposables.add(
      client.onStatus((s) => {
        status.setStatus(s);
        chat.setStatus(s);
      })
    );
    // Theme switches: re-read once the new theme's CSS has applied (deduplicated by the widget).
    const themeChanged = () => {
      chat.themeChanged();
      setTimeout(() => chat.isDisposed || chat.themeChanged(), 300);
    };
    themeManager?.themeChanged.connect(themeChanged);
    const activeFileChanged = () => chat.activeFileChanged();
    app.shell.currentChanged?.connect(activeFileChanged);
    notebookTracker?.activeCellChanged.connect(activeFileChanged);
    editorTracker?.currentChanged.connect(activeFileChanged);
    // Selection moves inside CodeMirror (deduplicated by the widget).
    document.addEventListener('selectionchange', activeFileChanged);
    disposables.add({
      isDisposed: false,
      dispose() {
        themeManager?.themeChanged.disconnect(themeChanged);
        app.shell.currentChanged?.disconnect(activeFileChanged);
        notebookTracker?.activeCellChanged.disconnect(activeFileChanged);
        editorTracker?.currentChanged.disconnect(activeFileChanged);
        document.removeEventListener('selectionchange', activeFileChanged);
      }
    });

    // Approved agent edits (routed here by the server bridge by sessionId).
    disposables.add(
      client.onRequest('workspace/applyEdit', (params) =>
        applyEdit(params as ApplyEditParams, {
          resolveCell: (uri) => sync.cellForUri(uri) as { notebook: EditNotebook; cellId: string } | undefined,
          rootDir,
          docManager: docManager ?? undefined,
          contents: app.serviceManager.contents
        })
      )
    );

    // Commands, the open-chat keybinding, palette items, the status-bar menu.
    const commandDeps: CommandDeps = {
      commands: app.commands,
      activateById: (id) => app.shell.activateById(id),
      terminals: app.serviceManager.terminals,
      client,
      chat,
      settings: () => settings,
      setSetting,
      setCompletionsEnabled: async (on) => {
        await pluginSettings.set('completionsEnabled', on);
      },
      restartCore: async () => {
        await restart(settings);
        await checkStatus(commandDeps).catch(() => undefined);
      },
      onStatus: (s) => {
        status.setStatus(s);
        chat.setStatus(s);
      },
      copy: (text) => Clipboard.copyToSystem(text),
      ollamaCommand: () => fetchOllamaCommand(serverSettings),
      ui: {
        info: (message) => void Notification.info(message, { autoClose: 5000 }),
        error: (message) => void Notification.error(message, { autoClose: false }),
        pickItem: async (title, items, selected) => {
          const at = selected === undefined ? -1 : items.indexOf(selected);
          const result = await InputDialog.getItem({ title, items, current: Math.max(0, at), editable: false });
          return result.button.accept ? (result.value ?? undefined) : undefined;
        },
        confirm: async (title, body, acceptLabel) => {
          const result = await showDialog({
            title,
            body,
            buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: acceptLabel })]
          });
          return result.button.accept;
        },
        showText: async (title, body) => {
          const pre = document.createElement('pre');
          pre.textContent = body;
          pre.style.whiteSpace = 'pre-wrap';
          await showDialog({ title, body: new Widget({ node: pre }), buttons: [Dialog.okButton()] });
        }
      },
      palette
    };
    disposables.add(registerCommands(commandDeps));
    const menu = new Menu({ commands: app.commands });
    menu.title.label = 'LocalPilot';
    for (const command of Object.values(COMMANDS)) menu.addItem({ command });
    status.setOnClick(() => {
      const r = status.node.getBoundingClientRect();
      menu.open(r.left, r.top);
    });
    disposables.add(menu);

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
