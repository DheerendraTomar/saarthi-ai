import * as vscode from "vscode";
import { CHAT_VIEW_TYPE, type StatusNotification } from "./chat/chatView";
import { ACCEPT_COMMAND } from "./inlineProvider";
import type { CoreClient } from "./rpc/coreClient";
import type { Settings } from "./settings";
import { STATUS_MENU_COMMAND, type StatusBar } from "./statusBar";

export const COMMANDS = {
  openChat: "localpilot.openChat",
  startOllama: "localpilot.startOllama",
  pullModel: "localpilot.pullModel",
  newSession: "localpilot.newSession",
  toggleCompletions: "localpilot.toggleCompletions",
  restartCore: "localpilot.restartCore",
  completionAccepted: ACCEPT_COMMAND,
  statusMenu: STATUS_MENU_COMMAND,
} as const;

export const OLLAMA_TERMINAL = "Ollama";

/** Everything the commands act on; built once in `activate`. */
export interface CommandDeps {
  client: Pick<CoreClient, "request" | "onNotification" | "state">;
  statusBar: StatusBar;
  chatView: { newSession(): Promise<void> };
  reportAccepted(requestId: string): void;
  /** Current `localpilot.*` settings. */
  settings(): Settings;
  /** Applies a changed `completionsEnabled` right away (the core restart follows separately). */
  setCompletionsEnabled(enabled: boolean): void;
  /** Ollama status from `ollama/status` → status bar + chat view. */
  onStatus(status: StatusNotification): void;
  restartCore(): Promise<void>;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Opens (or re-shows) a terminal named "Ollama" running `ollama serve`. LocalPilot
 * never starts Ollama by itself: this runs only on a user click.
 */
export function startOllama(deps: Pick<CommandDeps, "client" | "onStatus">): void {
  let terminal = vscode.window.terminals.find((t) => t.name === OLLAMA_TERMINAL);
  if (!terminal) {
    terminal = vscode.window.createTerminal({ name: OLLAMA_TERMINAL });
    terminal.sendText("ollama serve");
  }
  terminal.show(true);
  // Give the server a moment, then re-check so the "down" warning clears by itself.
  for (const ms of [3000, 10000]) {
    setTimeout(() => void checkStatus(deps).catch(() => {}), ms).unref?.();
  }
}

/** Asks the core to probe Ollama again. */
export async function checkStatus(deps: Pick<CommandDeps, "client" | "onStatus">): Promise<void> {
  const status = await deps.client.request<StatusNotification>("ollama/status", {});
  deps.onStatus(status);
}

const pulling = new Set<string>();

/**
 * Pulls a model through the core (`ollama/pull`), with a progress notification
 * and status-bar percentage fed by `ollama/pullProgress`. `model` undefined →
 * pick one of the configured models; `""` (the chat UI's default) → the
 * completion model.
 */
export async function pullModel(deps: CommandDeps, model?: string): Promise<void> {
  const settings = deps.settings();
  let name = model?.trim();
  if (!name && model === "") name = settings.completionModel;
  if (!name) {
    const picked = await vscode.window.showQuickPick(
      [
        { label: settings.completionModel, description: "completion model" },
        { label: settings.chatModel, description: "chat model" },
      ],
      { placeHolder: "Model to pull with Ollama" },
    );
    name = picked?.label;
  }
  if (!name || pulling.has(name)) return;
  const target = name;
  pulling.add(target);
  deps.statusBar.setPull(0);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `LocalPilot: pulling ${target}` },
      async (progress) => {
        let reported = 0;
        const sub = deps.client.onNotification("ollama/pullProgress", (raw) => {
          const p = raw as { model: string; status: string; completed?: number; total?: number };
          if (p.model !== target) return;
          if (p.total && p.completed !== undefined) {
            const pct = (p.completed / p.total) * 100;
            progress.report({ message: p.status, increment: Math.max(0, pct - reported) });
            reported = Math.max(reported, pct);
            deps.statusBar.setPull(pct);
          } else {
            progress.report({ message: p.status });
          }
        });
        try {
          await deps.client.request("ollama/pull", { model: target });
        } finally {
          sub.dispose();
        }
      },
    );
    void vscode.window.showInformationMessage(`LocalPilot: ${target} is ready.`);
  } catch (e) {
    void vscode.window.showErrorMessage(`LocalPilot: pulling ${target} failed: ${errorMessage(e)}`);
  } finally {
    pulling.delete(target);
    deps.statusBar.setPull(undefined);
  }
}

export async function toggleCompletions(deps: Pick<CommandDeps, "setCompletionsEnabled">): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("localpilot");
  const next = !cfg.get<boolean>("completionsEnabled", true);
  deps.setCompletionsEnabled(next);
  // Write where the effective value comes from, so a workspace override can't make this a no-op.
  const where = cfg.inspect<boolean>("completionsEnabled");
  const target =
    where?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : where?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await cfg.update("completionsEnabled", next, target);
}

async function retry(deps: CommandDeps): Promise<void> {
  if (deps.client.state === "crashed" || deps.client.state === "stopped") return deps.restartCore();
  try {
    await checkStatus(deps);
  } catch (e) {
    void vscode.window.showErrorMessage(`LocalPilot: ${errorMessage(e)}`);
  }
}

/** The status-bar click menu. */
async function statusMenu(deps: CommandDeps): Promise<void> {
  const enabled = deps.settings().completionsEnabled;
  const items: Array<vscode.QuickPickItem & { run: () => unknown }> = [
    { label: "$(comment-discussion) Open chat", run: () => vscode.commands.executeCommand(COMMANDS.openChat) },
    { label: "$(play) Start Ollama", description: "opens a terminal running `ollama serve`", run: () => startOllama(deps) },
    { label: "$(refresh) Retry", description: "check Ollama again (restarts a stopped core)", run: () => retry(deps) },
    { label: "$(cloud-download) Pull model", run: () => pullModel(deps) },
    {
      label: enabled ? "$(debug-pause) Toggle completions" : "$(play) Toggle completions",
      description: enabled ? "pause inline completions" : "resume inline completions",
      run: () => toggleCompletions(deps),
    },
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "LocalPilot" });
  await picked?.run();
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const reg = (id: string, fn: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, fn);
  return [
    reg(COMMANDS.openChat, () => vscode.commands.executeCommand(`${CHAT_VIEW_TYPE}.focus`)),
    reg(COMMANDS.startOllama, () => startOllama(deps)),
    reg(COMMANDS.pullModel, (model?: string) => pullModel(deps, typeof model === "string" ? model : undefined)),
    reg(COMMANDS.newSession, async () => {
      await vscode.commands.executeCommand(`${CHAT_VIEW_TYPE}.focus`);
      await deps.chatView.newSession();
    }),
    reg(COMMANDS.toggleCompletions, () => toggleCompletions(deps)),
    reg(COMMANDS.restartCore, () => deps.restartCore()),
    reg(COMMANDS.completionAccepted, (requestId: string) => deps.reportAccepted(requestId)),
    reg(COMMANDS.statusMenu, () => statusMenu(deps)),
  ];
}
