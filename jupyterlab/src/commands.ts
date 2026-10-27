import type { CommandRegistry } from '@lumino/commands';
import { DisposableSet, type IDisposable } from '@lumino/disposable';
import { CHAT_WIDGET_ID, MODEL_SETTING, type ModelInfo, type ModelKind } from './chat/chatWidget';
import type { OllamaStatus, WsCoreClient } from './client';
import type { Settings } from './settings';

export const COMMANDS = {
  openChat: 'localpilot:open-chat',
  startOllama: 'localpilot:start-ollama',
  copyPullCommand: 'localpilot:copy-pull-command',
  newSession: 'localpilot:new-session',
  toggleCompletions: 'localpilot:toggle-completions',
  restartCore: 'localpilot:restart-core',
  selectChatModel: 'localpilot:select-chat-model',
  selectCompletionModel: 'localpilot:select-completion-model',
  showCompletionStats: 'localpilot:show-completion-stats',
  resetLearning: 'localpilot:reset-completion-learning'
} as const;

/**
 * `localpilot:open-chat`'s default keybinding: Alt+Shift+L (Option+Shift+L on
 * macOS). Declared under `jupyter.lab.shortcuts` in schema/plugin.json, so it
 * shows in Settings → Keyboard Shortcuts and can be rebound there; kept here
 * for tests and docs. (`Accel Shift L` is JupyterLab's `launcher:create`.)
 */
export const OPEN_CHAT_KEYS = ['Alt Shift L'];

export const PALETTE_CATEGORY = 'LocalPilot';

/** `Terminal.ITerminalConnection`, the part used here. */
export interface TerminalConnection {
  readonly name: string;
  readonly isDisposed: boolean;
  send(message: { type: 'stdin'; content: string[] }): void;
}

/** `Terminal.IManager`, the part used here. */
export interface TerminalManager {
  isAvailable(): boolean;
  running(): IterableIterator<{ name: string }>;
  startNew(): Promise<TerminalConnection>;
}

/** User-facing feedback (JupyterLab's `Notification` / `InputDialog` in the app; fakes in tests). */
export interface CommandUi {
  info(message: string): void;
  error(message: string): void;
  /** Lets the user pick one of `items` (not editable), `selected` preselected; undefined when cancelled. */
  pickItem(title: string, items: string[], selected?: string): Promise<string | undefined>;
  /** A confirmation dialog; true when the user chose `acceptLabel`. */
  confirm(title: string, body: string, acceptLabel: string): Promise<boolean>;
  /** Shows read-only text (multi-line) in a dialog. */
  showText(title: string, body: string): Promise<void>;
}

export interface CommandDeps {
  commands: CommandRegistry;
  /** `app.shell.activateById`. */
  activateById(id: string): void;
  terminals: TerminalManager;
  client: Pick<WsCoreClient, 'request' | 'onNotification'>;
  chat: {
    newSession(): Promise<void>;
    /** Sends the chat panel a fresh `models/list` (after a palette pick). */
    postModels?(): Promise<void>;
  };
  /** Current plugin settings. */
  settings(): Settings;
  /** Writes one plugin setting (a core setting restarts the core). */
  setSetting(key: keyof Settings, value: unknown): Promise<void>;
  /** Writes `completionsEnabled` to the plugin settings (client-only: no core restart). */
  setCompletionsEnabled(enabled: boolean): Promise<void>;
  /** `POST /localpilot/restart`, then reconnect a crashed client. */
  restartCore(): Promise<void>;
  /** Fresh Ollama status from `ollama/status` → status bar + chat. */
  onStatus(status: OllamaStatus): void;
  /** Copies text to the clipboard. */
  copy(text: string): Promise<void> | void;
  /** `GET /localpilot/ollama-command`: the sandboxed start line, or why there is none. */
  ollamaCommand(): Promise<{ command?: string; error?: string }>;
  ui: CommandUi;
  /** `ICommandPalette` when available. */
  palette?: { addItem(options: { command: string; category: string }): IDisposable } | null;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Asks the core to probe Ollama again. */
export async function checkStatus(deps: Pick<CommandDeps, 'client' | 'onStatus'>): Promise<void> {
  deps.onStatus(await deps.client.request<OllamaStatus>('ollama/status', {}));
}

/** The terminal this tab started for Ollama (reused while it is still running). */
let ollamaTerminal: TerminalConnection | undefined;

/**
 * Opens a JupyterLab terminal and types the line the server gives (Ollama
 * inside the no-network sandbox, or the sandboxed LaunchAgent), or re-shows
 * the terminal started earlier, if it still runs. LocalPilot never starts
 * Ollama by itself: this runs only on a user action. Where the server cannot
 * sandbox (not macOS), nothing starts. Then re-checks the status twice so a
 * "down" warning clears by itself.
 */
export async function startOllama(deps: CommandDeps): Promise<void> {
  if (!deps.terminals.isAvailable()) {
    deps.ui.error('LocalPilot: this Jupyter server has terminals disabled, so Ollama is not started. Start it yourself with OLLAMA_NO_CLOUD=1.');
    return;
  }
  try {
    const running = new Set([...deps.terminals.running()].map((t) => t.name));
    if (!ollamaTerminal || ollamaTerminal.isDisposed || !running.has(ollamaTerminal.name)) {
      const { command, error } = await deps.ollamaCommand();
      if (!command) {
        deps.ui.error(`LocalPilot: ${error ?? 'the server gave no command to start Ollama'}`);
        return;
      }
      ollamaTerminal = await deps.terminals.startNew();
      // Queued by the connection until its socket is open.
      ollamaTerminal.send({ type: 'stdin', content: [`${command}\n`] });
    }
    await deps.commands.execute('terminal:open', { name: ollamaTerminal.name });
  } catch (e) {
    deps.ui.error(`LocalPilot: could not start Ollama: ${errorMessage(e)}`);
    return;
  }
  for (const ms of [3000, 10000]) {
    setTimeout(() => void checkStatus(deps).catch(() => undefined), ms);
  }
}

/**
 * LocalPilot does not download models. Copies `ollama pull <model>` (to run in
 * a terminal) for the given model, or one the user picks of the configured ones.
 */
export async function copyPullCommand(deps: CommandDeps, model?: string): Promise<void> {
  const settings = deps.settings();
  let name = model?.trim();
  if (!name) {
    const choices = [...new Set([settings.completionModel, settings.chatModel])];
    name = (await deps.ui.pickItem('Model to pull in a terminal', choices, choices[0]))?.trim();
  }
  if (!name) return;
  const text = `ollama pull ${name}`;
  await deps.copy(text);
  deps.ui.info(`LocalPilot: copied \`${text}\`. Run it in a terminal.`);
}

/** `986000000` → "986 MB", `17000000000` → "17.0 GB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/**
 * Picks the chat or completion model from the models installed in Ollama
 * (core `ollama/models`) and writes it to the settings (the core restarts).
 */
export async function selectModel(deps: CommandDeps, kind: ModelKind): Promise<void> {
  let models: ModelInfo[];
  try {
    ({ models } = await deps.client.request<{ models: ModelInfo[] }>('ollama/models', {}));
  } catch (e) {
    deps.ui.error(`LocalPilot: Ollama is not reachable (${errorMessage(e)}). Start it (Start Ollama), then try again.`);
    return;
  }
  if (!Array.isArray(models) || models.length === 0) {
    deps.ui.error('LocalPilot: no models are installed in Ollama. Run `ollama pull <model>` in a terminal first (Copy Ollama Pull Command).');
    return;
  }
  const key = MODEL_SETTING[kind];
  const current = deps.settings()[key];
  const picked = await deps.ui.pickItem(
    kind === 'chat' ? 'Chat model' : 'Completion model',
    models.map((m) => m.name),
    current
  );
  if (!picked || picked === current) return;
  try {
    await deps.setSetting(key, picked);
  } catch (e) {
    deps.ui.error(`LocalPilot: could not save the ${kind} model: ${errorMessage(e)}`);
    return;
  }
  deps.ui.info(`LocalPilot: ${kind} model set to ${picked}.`);
  await deps.chat.postModels?.().catch(() => undefined);
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
  /** The limits were learned; `false`: the configured defaults (< 10 outcomes or adaptive off). */
  learned: boolean;
  examples: number;
}

/** Core `completion/stats` as text: one block per language, then the log path. */
export function formatStats(stats: { languages?: Record<string, LanguageStats>; logPath?: string | null; adaptive?: boolean }): string {
  const lines: string[] = [];
  for (const [lang, l] of Object.entries(stats.languages ?? {})) {
    lines.push(
      `${lang}: ${Math.round(l.acceptRate * 100)}% accepted of ${l.served}`,
      `  accepted ${l.accepted} · partial ${l.partial} · typed through ${l.typedThrough} · rejected ${l.rejected}`,
      `  ${l.learned && stats.adaptive ? 'learned' : 'default'}: ${l.learnedMaxLines} lines, ${l.learnedNumPredict} tokens, ` +
        `${l.examples} example${l.examples === 1 ? '' : 's'}`
    );
  }
  if (lines.length === 0) lines.push('No completion outcomes recorded yet.');
  lines.push('', `Adaptive completions: ${stats.adaptive ? 'on' : 'off'}`);
  if (stats.logPath) lines.push(`Outcome log: ${stats.logPath}`);
  return lines.join('\n');
}

/** Shows core `completion/stats`. */
export async function showCompletionStats(deps: CommandDeps): Promise<void> {
  let stats: Parameters<typeof formatStats>[0];
  try {
    stats = await deps.client.request('completion/stats', {});
  } catch (e) {
    deps.ui.error(`LocalPilot: could not read completion stats: ${errorMessage(e)}`);
    return;
  }
  await deps.ui.showText('LocalPilot completion stats', formatStats(stats));
}

/** Core `completion/resetLearning` after a confirmation (the outcome log itself is kept). */
export async function resetLearning(deps: CommandDeps): Promise<void> {
  const ok = await deps.ui.confirm(
    'Reset completion learning?',
    'Reset what LocalPilot learned from your completions (lengths and style examples)? The outcome log is kept.',
    'Reset'
  );
  if (!ok) return;
  try {
    await deps.client.request('completion/resetLearning', {});
    deps.ui.info('LocalPilot: completion learning was reset.');
  } catch (e) {
    deps.ui.error(`LocalPilot: could not reset learning: ${errorMessage(e)}`);
  }
}

/** Registers the LocalPilot commands and their palette items (the open-chat shortcut is in the schema). */
export function registerCommands(deps: CommandDeps): IDisposable {
  const set = new DisposableSet();
  const { commands } = deps;
  const openChat = () => deps.activateById(CHAT_WIDGET_ID);
  const report = (what: string) => (e: unknown) => deps.ui.error(`LocalPilot: ${what} failed: ${errorMessage(e)}`);

  set.add(commands.addCommand(COMMANDS.openChat, { label: 'Open LocalPilot Chat', execute: openChat }));
  set.add(
    commands.addCommand(COMMANDS.startOllama, {
      label: 'Start Ollama (sandboxed, in a terminal)',
      caption: 'Opens a JupyterLab terminal that starts Ollama inside a no-network sandbox (macOS)',
      execute: () => startOllama(deps)
    })
  );
  set.add(
    commands.addCommand(COMMANDS.copyPullCommand, {
      label: 'Copy Ollama Pull Command…',
      caption: 'Copies `ollama pull <model>`; LocalPilot does not download models',
      execute: (args) => copyPullCommand(deps, typeof args.model === 'string' ? args.model : undefined)
    })
  );
  set.add(
    commands.addCommand(COMMANDS.newSession, {
      label: 'New LocalPilot Chat Session',
      execute: async () => {
        openChat();
        await deps.chat.newSession();
      }
    })
  );
  set.add(
    commands.addCommand(COMMANDS.toggleCompletions, {
      label: () => (deps.settings().completionsEnabled ? 'Pause Inline Completions' : 'Resume Inline Completions'),
      isToggled: () => deps.settings().completionsEnabled,
      execute: () => deps.setCompletionsEnabled(!deps.settings().completionsEnabled).catch(report('changing the setting'))
    })
  );
  set.add(
    commands.addCommand(COMMANDS.restartCore, {
      label: 'Restart LocalPilot Core',
      execute: () => deps.restartCore().catch(report('restarting the core'))
    })
  );
  set.add(
    commands.addCommand(COMMANDS.selectChatModel, {
      label: 'Select Chat Model…',
      execute: () => selectModel(deps, 'chat')
    })
  );
  set.add(
    commands.addCommand(COMMANDS.selectCompletionModel, {
      label: 'Select Completion Model…',
      execute: () => selectModel(deps, 'completion')
    })
  );
  set.add(
    commands.addCommand(COMMANDS.showCompletionStats, {
      label: 'Show Completion Stats',
      execute: () => showCompletionStats(deps)
    })
  );
  set.add(
    commands.addCommand(COMMANDS.resetLearning, {
      label: 'Reset Completion Learning…',
      execute: () => resetLearning(deps)
    })
  );
  for (const command of Object.values(COMMANDS)) {
    const item = deps.palette?.addItem({ command, category: PALETTE_CATEGORY });
    if (item) set.add(item);
  }
  return set;
}
