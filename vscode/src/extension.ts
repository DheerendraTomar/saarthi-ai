import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { applyEdit, type ApplyEditParams } from "./chat/applyEdit";
import { CHAT_VIEW_TYPE, ChatViewProvider, type StatusNotification } from "./chat/chatView";
import { runCommand, type RunCommandParams } from "./chat/runCommand";
import { checkStatus, COMMANDS, pullModel, registerCommands, startOllama, type CommandDeps } from "./commands";
import { DocumentSync } from "./documentSync";
import { InlineProvider } from "./inlineProvider";
import { ModelCatalog } from "./models";
import { CoreClient, type CoreClientOptions } from "./rpc/coreClient";
import { readSettings, resolveBinaryPath, type Settings } from "./settings";
import { StatusBar } from "./statusBar";

/** Settings changes are batched for this long before the core restarts. */
export const RESTART_DEBOUNCE_MS = 500;

/** Returned from `activate` for tests (the e2e smoke test reads it through `extension.exports`). */
export interface LocalPilotApi {
  client: CoreClient;
  inline: InlineProvider;
  chatView: ChatViewProvider;
  statusBar: StatusBar;
  /** Settles when the first core start has finished (successfully or not). */
  ready: Promise<void>;
}

let current: { client: CoreClient } | undefined;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function activate(context: vscode.ExtensionContext): LocalPilotApi | undefined {
  const output = vscode.window.createOutputChannel("LocalPilot");
  const statusBar = new StatusBar();
  context.subscriptions.push(output, statusBar);
  let lastLoggedError: string | undefined;
  const log = (level: string, message: string) => {
    if (level === "error") lastLoggedError = message;
    output.appendLine(`[${new Date().toISOString()}] [${level}] ${message}`);
  };

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    statusBar.setCommand(undefined); // no commands are registered in a folderless window
    statusBar.setCoreState("crashed", "open a folder to use LocalPilot");
    log("info", "No workspace folder is open; LocalPilot needs one.");
    return undefined;
  }

  let settings: Settings = readSettings();
  // CoreClient reads binaryPath/logLevel on every launch, so restarts pick up changes made here.
  const coreOptions: CoreClientOptions = { binaryPath: "", workspaceRoot: root, logLevel: settings.logLevel, onLog: log };
  const client = new CoreClient(coreOptions);
  current = { client };
  const inline = new InlineProvider(client, settings);
  const sync = new DocumentSync(client, root);
  // One `ollama/models` cache for the chat view and the palette pickers (the last-known list while Ollama is down).
  const models = new ModelCatalog(client);

  let lastCoreError: string | undefined;
  const reportCoreError = (message: string) => {
    lastCoreError = message;
    log("error", message);
    statusBar.setCoreState("crashed", message);
    void vscode.window.showErrorMessage(message, "Restart Core", "Show Log").then((choice) => {
      if (choice === "Restart Core") void vscode.commands.executeCommand(COMMANDS.restartCore);
      if (choice === "Show Log") output.show();
    });
  };

  /** (Re)starts the core with the current settings; resolves the binary again each time. */
  let started = false;
  /** The settings the running core was initialized with (to skip restarts for client-only changes). */
  let coreSettings: Settings | undefined;
  const startCoreOnce = async (): Promise<void> => {
    settings = readSettings();
    coreSettings = settings;
    lastCoreError = undefined;
    lastLoggedError = undefined;
    try {
      coreOptions.binaryPath = resolveBinaryPath(context.extensionPath, { coreBinaryPath: settings.coreBinaryPath });
    } catch (e) {
      if (started) await client.stop();
      reportCoreError(errorMessage(e));
      return;
    }
    coreOptions.logLevel = settings.logLevel;
    try {
      const forCore = coreInitSettings(settings);
      if (started) await client.restart(forCore);
      else await client.start(forCore);
      started = true;
    } catch (e) {
      started = true;
      if (client.state !== "crashed") reportCoreError(`LocalPilot core failed to start: ${errorMessage(e)}`);
    }
  };

  // Restarts are serialized: overlapping requests (Restart Core during a settings
  // restart, a slow shutdown) coalesce into one more run instead of launching two cores.
  let inFlight: Promise<void> | undefined;
  let again = false;
  const startCore = (): Promise<void> => {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        do {
          again = false;
          await startCoreOnce();
        } while (again);
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  const onStatus = (status: StatusNotification) => {
    statusBar.setStatus(status);
    chatView.setStatus(status);
  };

  const deps: CommandDeps = {
    client,
    statusBar,
    chatView: {
      newSession: () => chatView.newSession(),
      deleteSession: (id) => chatView.deleteSession(id),
      clearSessions: () => chatView.clearSessions(),
      postModels: () => chatView.postModels(),
    },
    models,
    reportAccepted: (id) => inline.reportAccepted(id),
    settings: () => settings,
    setCompletionsEnabled: (enabled) => {
      settings = { ...settings, completionsEnabled: enabled };
      inline.updateSettings(settings);
      statusBar.setCompletionsEnabled(enabled);
    },
    onStatus,
    restartCore: startCore,
  };

  const chatView = new ChatViewProvider(client, {
    extensionUri: context.extensionUri,
    root,
    html: () => readFileSync(join(context.extensionPath, "media", "chat.html"), "utf8"),
    startOllama: () => startOllama(deps),
    pullModel: (model) => pullModel(deps, model),
    // The core pauses completions while chat generates (spec §5(10)); show it.
    onChatActiveChanged: (active) => statusBar.setChatActive(active),
    models,
  });

  // Core → client requests (the core sends them only after the user approved in the chat).
  client.onRequest("workspace/applyEdit", (params) => applyEdit(params as ApplyEditParams, { resolveCell: (uri) => sync.cellForUri(uri) }));
  client.onRequest("workspace/runCommand", (params) => runCommand(params as RunCommandParams, output, { defaultCwd: root }));
  // The chat view relays `status` to the webview itself; the status bar listens here.
  client.onNotification("status", (params) => statusBar.setStatus(params as StatusNotification));
  client.onDidChangeState((state) => {
    statusBar.setCoreState(state, lastCoreError);
    if (state === "ready") {
      lastCoreError = undefined;
      // Covers first start, settings restarts and crash restarts alike.
      void checkStatus(deps).catch(() => {});
    }
    if (state === "crashed" && !lastCoreError) {
      // CoreClient logged why (spawn failure, refused initialize, too many crashes).
      reportCoreError(lastLoggedError ?? "LocalPilot core stopped. See the LocalPilot output and .localpilot/core.log.");
    }
  });

  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    sync,
    chatView,
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, inline),
    inline,
    // Partial accepts and typed-through suggestions are only visible as document changes.
    vscode.workspace.onDidChangeTextDocument((e) => inline.onDidChangeTextDocument(e)),
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_TYPE, chatView, { webviewOptions: { retainContextWhenHidden: true } }),
    ...registerCommands(deps),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("localpilot")) return;
      settings = readSettings();
      inline.updateSettings(settings);
      statusBar.setCompletionsEnabled(settings.completionsEnabled);
      // The core takes settings only at initialize: restart it once the edits settle,
      // unless only client-side settings changed (a restart would end a running chat reply).
      clearTimeout(restartTimer);
      if (coreSettings && sameCoreSettings(coreSettings, settings)) return;
      restartTimer = setTimeout(() => void startCore(), RESTART_DEBOUNCE_MS);
    }),
    { dispose: () => clearTimeout(restartTimer) },
  );
  statusBar.setCompletionsEnabled(settings.completionsEnabled);

  const ready = startCore();
  return { client, inline, chatView, statusBar, ready };
}

/**
 * The settings sent in `initialize`. Completions are always enabled in the core
 * (it would otherwise answer empty until restarted); the InlineProvider gates
 * them on the user's `completionsEnabled`, so toggling needs no restart.
 */
export function coreInitSettings(s: Settings): Settings {
  return { ...s, completionsEnabled: true };
}

/** Settings the client applies itself (the core never reads completionDebounceMs and always gets completionsEnabled: true); changing only these does not restart the core. */
const CLIENT_ONLY_SETTINGS: ReadonlyArray<keyof Settings> = ["completionsEnabled", "completionDebounceMs"];

export function sameCoreSettings(a: Settings, b: Settings): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Array<keyof Settings>);
  for (const k of keys) {
    if (CLIENT_ONLY_SETTINGS.includes(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

export function deactivate(): Promise<unknown> | undefined {
  const c = current;
  current = undefined;
  return c?.client.stop();
}
