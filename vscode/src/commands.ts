import * as vscode from "vscode";
import { CHAT_VIEW_TYPE, type ClearResult, type StatusNotification } from "./chat/chatView";
import { ACCEPT_COMMAND } from "./inlineProvider";
import type { CoreClient } from "./rpc/coreClient";
import { formatSize, MODEL_SETTING, type ModelCatalog, type ModelInfo, type ModelKind } from "./models";
import { updateSetting, type Settings } from "./settings";
import { STATUS_MENU_COMMAND, type StatusBar } from "./statusBar";

export const COMMANDS = {
  openChat: "localpilot.openChat",
  startOllama: "localpilot.startOllama",
  pullModel: "localpilot.pullModel",
  newSession: "localpilot.newSession",
  toggleCompletions: "localpilot.toggleCompletions",
  restartCore: "localpilot.restartCore",
  selectChatModel: "localpilot.selectChatModel",
  selectCompletionModel: "localpilot.selectCompletionModel",
  deleteSession: "localpilot.deleteSession",
  clearSessions: "localpilot.clearSessions",
  resetLearning: "localpilot.resetLearning",
  showCompletionStats: "localpilot.showCompletionStats",
  completionAccepted: ACCEPT_COMMAND,
  statusMenu: STATUS_MENU_COMMAND,
} as const;

export const OLLAMA_TERMINAL = "Ollama";

/** Everything the commands act on; built once in `activate`. */
export interface CommandDeps {
  client: Pick<CoreClient, "request" | "onNotification" | "state">;
  statusBar: StatusBar;
  chatView: {
    newSession(): Promise<void>;
    /** Deletes through the chat view so the webview drops it too; resolves to an error message when refused. */
    deleteSession(sessionId: string): Promise<string | undefined | void>;
    clearSessions(): Promise<ClearResult>;
  };
  /** Shared `ollama/models` cache (the chat view fills it too). */
  models: ModelCatalog;
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
    // Clears a "model missing" warning right away (the core's next probe could be 30 s off).
    await checkStatus(deps).catch(() => {});
  } catch (e) {
    void vscode.window.showErrorMessage(`LocalPilot: pulling ${target} failed: ${errorMessage(e)}`);
  } finally {
    pulling.delete(target);
    deps.statusBar.setPull(undefined);
  }
}

export async function toggleCompletions(deps: Pick<CommandDeps, "setCompletionsEnabled">): Promise<void> {
  const next = !vscode.workspace.getConfiguration("localpilot").get<boolean>("completionsEnabled", true);
  deps.setCompletionsEnabled(next);
  await updateSetting("completionsEnabled", next);
}

type Action = vscode.QuickPickItem & { run?: () => unknown; model?: string };

/**
 * Quick pick of the installed models (core `ollama/models`) for the chat or
 * completion model, with size, family and capability hints; the current one
 * is marked. Picking writes `localpilot.chatModel` / `completionModel` (to
 * the scope that defines it), which restarts the core. When Ollama cannot be
 * reached the picker says so and offers Start Ollama / Retry, above the last
 * known list if there is one.
 */
export async function selectModel(deps: Pick<CommandDeps, "models" | "settings" | "client" | "onStatus"> & { startOllama?: () => void }, kind: ModelKind): Promise<void> {
  for (;;) {
    let models: ModelInfo[];
    let error: string | undefined;
    try {
      models = await deps.models.fetch();
    } catch (e) {
      error = errorMessage(e);
      models = deps.models.lastKnown ?? [];
    }
    const current = deps.settings()[MODEL_SETTING[kind]];
    const items: Action[] = [];
    if (error !== undefined) {
      items.push(
        { label: "$(play) Start Ollama", description: "opens a terminal running `ollama serve`", run: () => (deps.startOllama ?? (() => startOllama(deps)))() },
        { label: "$(refresh) Retry", run: () => "retry" },
      );
    }
    for (const m of models) items.push(modelItem(m, kind, m.name === current));
    const placeHolder =
      error === undefined
        ? `${kind === "chat" ? "Chat" : "Completion"} model (current: ${current})`
        : models.length > 0
          ? `Ollama down — last known list (${error})`
          : `Ollama is not reachable (${error}). Start it, then retry.`;
    const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
    if (!picked) return;
    if (picked.run) {
      if ((await picked.run()) === "retry") continue;
      return;
    }
    const name = picked.model;
    if (!name || name === current) return;
    await updateSetting(MODEL_SETTING[kind], name);
    const info = models.find((m) => m.name === name);
    if (kind === "completion" && info && !info.supportsInsert) {
      void vscode.window.showWarningMessage(`LocalPilot: ${name} does not support fill-in-the-middle; inline completions will be poor. A "-base" coder model works best.`);
    }
    return;
  }
}

function modelItem(m: ModelInfo, kind: ModelKind, isCurrent: boolean): Action {
  const description = [formatSize(m.sizeBytes), m.family].filter(Boolean).join(" · ");
  const detail =
    kind === "completion"
      ? m.supportsInsert
        ? "fill-in-the-middle"
        : "$(warning) no fill-in-the-middle: inline completions will be poor"
      : m.supportsTools
        ? "tool calling"
        : "$(warning) no tool calling: the agent cannot edit files or run commands";
  return { label: isCurrent ? `$(check) ${m.name}` : m.name, description, detail, picked: isCurrent, model: m.name };
}

interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAtMs: number;
}

/** Quick pick of the saved chat sessions → delete one (refused while its reply is running). */
export async function deleteSession(deps: Pick<CommandDeps, "client" | "chatView">): Promise<void> {
  const { sessions } = await deps.client.request<{ sessions: SessionSummary[] }>("chat/listSessions", {});
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage("LocalPilot: there are no chat sessions.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    sessions.map((s) => ({ label: s.title || "Untitled", description: new Date(s.updatedAtMs).toLocaleString(), sessionId: s.sessionId })),
    { placeHolder: "Chat session to delete" },
  );
  if (!picked) return;
  const error = await deps.chatView.deleteSession(picked.sessionId);
  if (typeof error === "string") void vscode.window.showErrorMessage(`LocalPilot: ${error}`);
}

/** Deletes every chat session after a confirmation (sessions with a running reply are kept). */
export async function clearSessions(deps: Pick<CommandDeps, "chatView">): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Delete all LocalPilot chat sessions? Sessions with a running reply are kept.",
    { modal: true },
    "Delete All",
  );
  if (choice !== "Delete All") return;
  try {
    const { deleted, skipped } = await deps.chatView.clearSessions();
    const kept = skipped.length > 0 ? ` (${skipped.length} with a running reply kept)` : "";
    void vscode.window.showInformationMessage(`LocalPilot: deleted ${deleted.length} chat session${deleted.length === 1 ? "" : "s"}${kept}.`);
  } catch (e) {
    void vscode.window.showErrorMessage(`LocalPilot: could not clear the chat sessions: ${errorMessage(e)}`);
  }
}

/** Core `completion/resetLearning` after a confirmation (the outcome log itself is kept). */
export async function resetLearning(deps: Pick<CommandDeps, "client">): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Reset what LocalPilot learned from your completions (lengths and style examples)? The outcome log is kept.",
    { modal: true },
    "Reset",
  );
  if (choice !== "Reset") return;
  try {
    await deps.client.request("completion/resetLearning", {});
    void vscode.window.showInformationMessage("LocalPilot: completion learning was reset.");
  } catch (e) {
    void vscode.window.showErrorMessage(`LocalPilot: could not reset learning: ${errorMessage(e)}`);
  }
}

interface LanguageStats {
  served: number;
  accepted: number;
  partial: number;
  rejected: number;
  typedThrough: number;
  acceptRate: number;
  learnedMaxLines: number;
  learnedNumPredict: number;
  examples: number;
}

/** Core `completion/stats` as a quick pick: one row per language, plus "open the log". */
export async function showCompletionStats(deps: Pick<CommandDeps, "client">): Promise<void> {
  let stats: { languages: Record<string, LanguageStats>; logPath: string | null; adaptive: boolean };
  try {
    stats = await deps.client.request("completion/stats", {});
  } catch (e) {
    void vscode.window.showErrorMessage(`LocalPilot: could not read completion stats: ${errorMessage(e)}`);
    return;
  }
  const items: Action[] = Object.entries(stats.languages).map(([lang, l]) => ({
    label: lang,
    description: `${Math.round(l.acceptRate * 100)}% accepted of ${l.served}`,
    detail:
      `accepted ${l.accepted} · partial ${l.partial} · typed through ${l.typedThrough} · rejected ${l.rejected}` +
      ` — learned: ${l.learnedMaxLines} lines, ${l.learnedNumPredict} tokens, ${l.examples} example${l.examples === 1 ? "" : "s"}`,
  }));
  if (items.length === 0) items.push({ label: "No completion outcomes recorded yet" });
  const logPath = stats.logPath;
  if (logPath) {
    items.push({
      label: "$(go-to-file) Open the completion log",
      description: logPath,
      run: () => vscode.commands.executeCommand("vscode.open", vscode.Uri.file(logPath)),
    });
  }
  const picked = await vscode.window.showQuickPick(items, { title: `LocalPilot completion stats — adaptive ${stats.adaptive ? "on" : "off"}` });
  await picked?.run?.();
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
    { label: "$(comment) Chat model", description: deps.settings().chatModel, run: () => selectModel(deps, "chat") },
    { label: "$(symbol-snippet) Completion model", description: deps.settings().completionModel, run: () => selectModel(deps, "completion") },
    { label: "$(graph) Completion stats", description: "accept rates and what was learned", run: () => showCompletionStats(deps) },
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
    reg(COMMANDS.selectChatModel, () => selectModel(deps, "chat")),
    reg(COMMANDS.selectCompletionModel, () => selectModel(deps, "completion")),
    reg(COMMANDS.deleteSession, () => deleteSession(deps)),
    reg(COMMANDS.clearSessions, () => clearSessions(deps)),
    reg(COMMANDS.resetLearning, () => resetLearning(deps)),
    reg(COMMANDS.showCompletionStats, () => showCompletionStats(deps)),
    reg(COMMANDS.completionAccepted, (requestId: string) => deps.reportAccepted(requestId)),
    reg(COMMANDS.statusMenu, () => statusMenu(deps)),
  ];
}
