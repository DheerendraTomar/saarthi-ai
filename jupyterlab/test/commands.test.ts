import { CommandRegistry } from '@lumino/commands';
import schema from '../schema/plugin.json';
import { CHAT_WIDGET_ID } from '../src/chat/chatWidget';
import { COMMANDS, OPEN_CHAT_KEYS, registerCommands, type CommandDeps, type TerminalConnection } from '../src/commands';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';

function setup() {
  const commands = new CommandRegistry();
  const opened: unknown[] = [];
  commands.addCommand('terminal:open', { execute: (args) => void opened.push(args) });
  const terminals: TerminalConnection[] = [];
  const running = new Set<string>();
  let settings: Settings = { ...DEFAULT_SETTINGS, completionModel: 'qwen-coder', chatModel: 'qwen-chat' };
  const requests: Array<[string, unknown]> = [];
  const answers = new Map<string, () => unknown>();
  const ollama: { command?: string; error?: string } = { command: 'SANDBOXED ollama serve' };
  const deps: CommandDeps = {
    commands,
    activateById: jest.fn(),
    terminals: {
      isAvailable: () => true,
      running: () => [...running].map((name) => ({ name }))[Symbol.iterator](),
      startNew: jest.fn(async () => {
        const t = { name: String(terminals.length + 1), isDisposed: false, send: jest.fn() };
        terminals.push(t);
        running.add(t.name);
        return t;
      })
    },
    client: {
      request: (async (method: string, params?: unknown) => {
        requests.push([method, params]);
        const answer = answers.get(method);
        if (answer) return answer();
        return method === 'ollama/status' ? { ollama: 'ok', detail: '' } : {};
      }) as CommandDeps['client']['request'],
      onNotification: () => ({ isDisposed: false, dispose: () => undefined })
    },
    chat: { newSession: jest.fn(async () => undefined), postModels: jest.fn(async () => undefined) },
    settings: () => settings,
    setSetting: jest.fn(async (key: keyof Settings, value: unknown) => {
      settings = { ...settings, [key]: value };
    }),
    setCompletionsEnabled: jest.fn(async (on: boolean) => {
      settings = { ...settings, completionsEnabled: on };
    }),
    restartCore: jest.fn(async () => undefined),
    onStatus: jest.fn(),
    copy: jest.fn(async () => undefined),
    ollamaCommand: jest.fn(async () => ollama),
    ui: {
      info: jest.fn(),
      error: jest.fn(),
      pickItem: jest.fn(async () => undefined),
      confirm: jest.fn(async () => false),
      showText: jest.fn(async () => undefined)
    }
  };
  const registered = registerCommands(deps);
  return { commands, deps, opened, terminals, running, requests, ollama, registered, answers, current: () => settings };
}

describe('open-chat shortcut', () => {
  it('is_declared_in_the_schema_with_a_free_chord', () => {
    expect(schema['jupyter.lab.shortcuts']).toEqual([{ command: COMMANDS.openChat, keys: OPEN_CHAT_KEYS, selector: 'body' }]);
    // JupyterLab's own launcher:create owns Accel Shift L.
    expect(OPEN_CHAT_KEYS).not.toContain('Accel Shift L');
  });
});

describe('commands', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('registers_commands_and_the_open_chat_keybinding', async () => {
    const { commands, deps, registered } = setup();
    for (const id of Object.values(COMMANDS)) expect(commands.hasCommand(id)).toBe(true);
    // The keybinding is declared in the settings schema (rebindable), not added here.
    expect(commands.keyBindings).toHaveLength(0);
    expect(OPEN_CHAT_KEYS).toEqual(['Alt Shift L']);

    await commands.execute(COMMANDS.openChat);
    expect(deps.activateById).toHaveBeenCalledWith(CHAT_WIDGET_ID);
    await commands.execute(COMMANDS.newSession);
    expect(deps.chat.newSession).toHaveBeenCalledTimes(1);

    expect(commands.label(COMMANDS.toggleCompletions)).toBe('Pause Inline Completions');
    await commands.execute(COMMANDS.toggleCompletions);
    expect(deps.setCompletionsEnabled).toHaveBeenCalledWith(false);
    expect(commands.label(COMMANDS.toggleCompletions)).toBe('Resume Inline Completions');

    await commands.execute(COMMANDS.restartCore);
    expect(deps.restartCore).toHaveBeenCalledTimes(1);

    registered.dispose();
    expect(commands.hasCommand(COMMANDS.openChat)).toBe(false);
  });

  it('start_ollama_types_the_servers_sandboxed_command_in_a_terminal', async () => {
    const { commands, deps, opened, terminals, running } = setup();
    await commands.execute(COMMANDS.startOllama);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].send).toHaveBeenCalledWith({ type: 'stdin', content: ['SANDBOXED ollama serve\n'] });
    expect(opened).toEqual([{ name: '1' }]);

    // Still running: re-shown, not started twice.
    await commands.execute(COMMANDS.startOllama);
    expect(terminals).toHaveLength(1);
    expect(deps.ollamaCommand).toHaveBeenCalledTimes(1);
    expect(opened).toEqual([{ name: '1' }, { name: '1' }]);

    await jest.advanceTimersByTimeAsync(3000);
    expect(deps.onStatus).toHaveBeenCalledWith({ ollama: 'ok', detail: '' });

    // Closed by the user: a new one.
    running.clear();
    await commands.execute(COMMANDS.startOllama);
    expect(terminals).toHaveLength(2);
  });

  it('start_ollama_shows_the_servers_refusal_and_opens_no_terminal', async () => {
    const { commands, deps, terminals, ollama } = setup();
    delete ollama.command;
    ollama.error = 'LocalPilot only starts Ollama inside a no-network sandbox, which needs macOS.';
    await commands.execute(COMMANDS.startOllama);
    expect(terminals).toHaveLength(0);
    expect(deps.ui.error).toHaveBeenCalledWith(expect.stringContaining('needs macOS'));
  });

  it('copy_pull_command_copies_and_never_pulls', async () => {
    const { commands, deps, requests } = setup();
    await commands.execute(COMMANDS.copyPullCommand, { model: 'qwen-coder' });
    expect(deps.copy).toHaveBeenCalledWith('ollama pull qwen-coder');

    // No model given: the user picks one of the configured models.
    (deps.ui.pickItem as jest.Mock).mockResolvedValueOnce('qwen-chat');
    await commands.execute(COMMANDS.copyPullCommand);
    expect(deps.ui.pickItem).toHaveBeenCalledWith('Model to pull in a terminal', ['qwen-coder', 'qwen-chat'], 'qwen-coder');
    expect(deps.copy).toHaveBeenLastCalledWith('ollama pull qwen-chat');
    expect(requests.filter(([m]) => m === 'ollama/pull')).toHaveLength(0);
  });

  it('select_model_writes_the_picked_installed_model', async () => {
    const { commands, deps, answers, current } = setup();
    answers.set('ollama/models', () => ({
      models: [
        { name: 'qwen-chat', sizeBytes: 17e9, supportsInsert: false, supportsTools: true },
        { name: 'fim-2', sizeBytes: 986e6, supportsInsert: true, supportsTools: false }
      ]
    }));
    (deps.ui.pickItem as jest.Mock).mockResolvedValueOnce('fim-2');
    await commands.execute(COMMANDS.selectCompletionModel);
    const [title, items, selected] = (deps.ui.pickItem as jest.Mock).mock.calls[0];
    expect(title).toBe('Completion model');
    expect(items).toEqual(['qwen-chat', 'fim-2']);
    expect(selected).toBe('qwen-coder'); // not installed: nothing preselected beyond the current name
    expect(deps.setSetting).toHaveBeenCalledWith('completionModel', 'fim-2');
    expect(current().completionModel).toBe('fim-2');
    expect(deps.chat.postModels).toHaveBeenCalled();

    // Cancelled: nothing written.
    await commands.execute(COMMANDS.selectChatModel);
    expect(deps.setSetting).toHaveBeenCalledTimes(1);

    // Ollama down: an error, no picker.
    answers.set('ollama/models', () => {
      throw new Error('connection refused');
    });
    await commands.execute(COMMANDS.selectChatModel);
    expect(deps.ui.pickItem).toHaveBeenCalledTimes(2);
    expect((deps.ui.error as jest.Mock).mock.calls.at(-1)[0]).toContain('connection refused');
  });

  it('reset_learning_asks_first_and_stats_are_shown', async () => {
    const { commands, deps, requests, answers } = setup();
    await commands.execute(COMMANDS.resetLearning);
    expect(deps.ui.confirm).toHaveBeenCalledTimes(1);
    expect(requests.filter(([m]) => m === 'completion/resetLearning')).toHaveLength(0);
    (deps.ui.confirm as jest.Mock).mockResolvedValueOnce(true);
    await commands.execute(COMMANDS.resetLearning);
    expect(requests.filter(([m]) => m === 'completion/resetLearning')).toHaveLength(1);
    expect(deps.ui.info).toHaveBeenLastCalledWith('LocalPilot: completion learning was reset.');

    answers.set('completion/stats', () => ({
      languages: {
        python: {
          served: 20,
          accepted: 8,
          partial: 2,
          rejected: 9,
          typedThrough: 1,
          acceptRate: 0.5,
          learnedMaxLines: 4,
          learnedNumPredict: 48,
          learned: true,
          examples: 3
        }
      },
      logPath: '/w/.localpilot/completions.jsonl',
      adaptive: true
    }));
    await commands.execute(COMMANDS.showCompletionStats);
    const [title, body] = (deps.ui.showText as jest.Mock).mock.calls[0];
    expect(title).toBe('LocalPilot completion stats');
    expect(body).toContain('python: 50% accepted of 20');
    expect(body).toContain('accepted 8 · partial 2 · typed through 1 · rejected 9');
    expect(body).toContain('learned: 4 lines, 48 tokens, 3 examples');
    expect(body).toContain('/w/.localpilot/completions.jsonl');
  });
});
