// Minimal stand-in for the `vscode` module in unit tests (aliased in vitest.config.ts).
// Tests set `configValues` to control what getConfiguration() returns, fire the
// exported `events` emitters, and push into `workspace.textDocuments` /
// `workspace.notebookDocuments` / `workspace.workspaceFolders`.

export const configValues: Record<string, unknown> = {};

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly fragment: string = "",
  ) {}
  get fsPath(): string {
    return this.path;
  }
  static file(path: string): Uri {
    return new Uri("file", path);
  }
  static from(parts: { scheme: string; path: string; fragment?: string }): Uri {
    return new Uri(parts.scheme, parts.path, parts.fragment);
  }
  /** Inverse of `toString()` (`file:///a/b.py`, `untitled:Untitled-1`, …). */
  static parse(value: string): Uri {
    const m = /^([a-zA-Z][\w+.-]*):(?:\/\/)?([^#]*)(?:#(.*))?$/.exec(value);
    if (!m) throw new Error(`bad uri: ${value}`);
    return new Uri(m[1], decodeURI(m[2]), m[3] ?? "");
  }
  toString(): string {
    const base = this.scheme === "file" ? `file://${encodeURI(this.path)}` : `${this.scheme}:${encodeURI(this.path)}`;
    return this.fragment ? `${base}#${this.fragment}` : base;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}

export class InlineCompletionItem {
  constructor(
    public insertText: string,
    public range?: Range,
    public command?: { command: string; title: string; arguments?: unknown[] },
  ) {}
}

export enum NotebookCellKind {
  Markup = 1,
  Code = 2,
}

export const events = {
  openText: new EventEmitter<unknown>(),
  changeText: new EventEmitter<unknown>(),
  closeText: new EventEmitter<unknown>(),
  saveText: new EventEmitter<unknown>(),
  openNotebook: new EventEmitter<unknown>(),
  changeNotebook: new EventEmitter<unknown>(),
  closeNotebook: new EventEmitter<unknown>(),
  saveNotebook: new EventEmitter<unknown>(),
};

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
  textDocuments: [] as unknown[],
  notebookDocuments: [] as unknown[],
  onDidOpenTextDocument: events.openText.event,
  onDidChangeTextDocument: events.changeText.event,
  onDidCloseTextDocument: events.closeText.event,
  onDidSaveTextDocument: events.saveText.event,
  onDidOpenNotebookDocument: events.openNotebook.event,
  onDidChangeNotebookDocument: events.changeNotebook.event,
  onDidCloseNotebookDocument: events.closeNotebook.event,
  onDidSaveNotebookDocument: events.saveNotebook.event,
  getConfiguration(section?: string) {
    const prefix = section ? `${section}.` : "";
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const full = prefix + key;
        return full in configValues ? (configValues[full] as T) : defaultValue;
      },
    };
  },
};

// ---------------------------------------------------------------- Task 6 additions
// Everything below is reassignable or inspectable from tests; call `resetMock()`
// in `beforeEach` to restore the defaults.

export class Selection extends Range {
  constructor(
    readonly anchor: Position,
    readonly active: Position,
  ) {
    super(anchor, active);
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

export type WorkspaceEditEntry =
  | { kind: "replace"; uri: Uri; range: Range; newText: string }
  | { kind: "createFile"; uri: Uri; options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array } };

export class WorkspaceEdit {
  readonly ops: WorkspaceEditEntry[] = [];
  replace(uri: Uri, range: Range, newText: string): void {
    this.ops.push({ kind: "replace", uri, range, newText });
  }
  createFile(uri: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array }): void {
    this.ops.push({ kind: "createFile", uri, options });
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export interface MockOutputChannel {
  name: string;
  lines: string[];
  text: string;
  append(s: string): void;
  appendLine(s: string): void;
  show(): void;
  dispose(): void;
}

export interface MockStatusBarItem {
  text: string;
  tooltip?: string;
  command?: string;
  backgroundColor?: ThemeColor;
  visible: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface MockTerminal {
  name: string;
  sent: string[];
  shown: boolean;
  sendText(text: string): void;
  show(): void;
  dispose(): void;
}

export const editorEvents = {
  activeEditor: new EventEmitter<unknown>(),
  selection: new EventEmitter<unknown>(),
  configuration: new EventEmitter<unknown>(),
};

type Handler = (...args: unknown[]) => unknown;

export const registry = {
  commands: new Map<string, Handler>(),
  executed: [] as Array<{ command: string; args: unknown[] }>,
  webviewViews: new Map<string, { provider: unknown; options?: unknown }>(),
  inlineProviders: [] as Array<{ selector: unknown; provider: unknown }>,
  outputChannels: [] as MockOutputChannel[],
  statusBarItems: [] as MockStatusBarItem[],
  terminals: [] as MockTerminal[],
  messages: [] as Array<{ level: "info" | "warn" | "error"; message: string }>,
  clipboard: "",
  configUpdates: [] as Array<{ key: string; value: unknown; target: unknown }>,
  progress: [] as Array<{ message?: string; increment?: number }>,
};

function disposable(fn: () => void = () => {}) {
  return { dispose: fn };
}

const defaultApplyEdit: (edit: WorkspaceEdit) => Promise<boolean> = async () => true;
const defaultOpenTextDocument: (uri: Uri) => Promise<unknown> = async () => {
  throw new Error("openTextDocument not stubbed");
};

Object.assign(workspace, {
  applyEdit: defaultApplyEdit,
  openTextDocument: defaultOpenTextDocument,
  onDidChangeConfiguration: editorEvents.configuration.event,
});
// Give getConfiguration an `update` that writes through to configValues.
/** Full keys (`localpilot.x`) whose `configValues` entry is a workspace setting (see `inspect`). */
export const workspaceConfigKeys = new Set<string>();
const baseGetConfiguration = workspace.getConfiguration;
Object.assign(workspace, {
  getConfiguration(section?: string) {
    const prefix = section ? `${section}.` : "";
    return {
      ...baseGetConfiguration(section),
      async update(key: string, value: unknown, target?: unknown) {
        configValues[prefix + key] = value;
        registry.configUpdates.push({ key: prefix + key, value, target });
      },
      /** Values listed in `workspaceConfigKeys` count as workspace-level, the rest as global. */
      inspect(key: string) {
        const full = prefix + key;
        if (!(full in configValues)) return { key: full };
        return workspaceConfigKeys.has(full) ? { key: full, workspaceValue: configValues[full] } : { key: full, globalValue: configValues[full] };
      },
    };
  },
});

/** Typed view of the reassignable workspace functions added above. */
export const workspaceFns = workspace as typeof workspace & {
  applyEdit: (edit: WorkspaceEdit) => Promise<boolean>;
  openTextDocument: (uri: Uri) => Promise<unknown>;
};

export const window = {
  activeTextEditor: undefined as unknown,
  onDidChangeActiveTextEditor: editorEvents.activeEditor.event,
  onDidChangeTextEditorSelection: editorEvents.selection.event,
  get terminals(): MockTerminal[] {
    return registry.terminals;
  },
  createOutputChannel(name: string): MockOutputChannel {
    const ch: MockOutputChannel = {
      name,
      lines: [],
      text: "",
      append(s) {
        ch.text += s;
      },
      appendLine(s) {
        ch.text += s + "\n";
        ch.lines.push(s);
      },
      show() {},
      dispose() {},
    };
    registry.outputChannels.push(ch);
    return ch;
  },
  createStatusBarItem(): MockStatusBarItem {
    const item: MockStatusBarItem = {
      text: "",
      visible: false,
      show() {
        item.visible = true;
      },
      hide() {
        item.visible = false;
      },
      dispose() {},
    };
    registry.statusBarItems.push(item);
    return item;
  },
  createTerminal(opts: { name: string } | string): MockTerminal {
    const t: MockTerminal = {
      name: typeof opts === "string" ? opts : opts.name,
      sent: [],
      shown: false,
      sendText(text) {
        t.sent.push(text);
      },
      show() {
        t.shown = true;
      },
      dispose() {},
    };
    registry.terminals.push(t);
    return t;
  },
  registerWebviewViewProvider(viewType: string, provider: unknown, options?: unknown) {
    registry.webviewViews.set(viewType, { provider, options });
    return disposable(() => registry.webviewViews.delete(viewType));
  },
  showQuickPick: (async () => undefined) as (items: unknown, opts?: unknown) => Promise<unknown>,
  showInputBox: (async () => undefined) as (opts?: unknown) => Promise<string | undefined>,
  async showInformationMessage(message: string): Promise<unknown> {
    registry.messages.push({ level: "info", message });
    return undefined;
  },
  async showWarningMessage(message: string): Promise<unknown> {
    registry.messages.push({ level: "warn", message });
    return undefined;
  },
  async showErrorMessage(message: string): Promise<unknown> {
    registry.messages.push({ level: "error", message });
    return undefined;
  },
  async withProgress<R>(
    _opts: unknown,
    task: (progress: { report(v: { message?: string; increment?: number }): void }, token: unknown) => Promise<R>,
  ): Promise<R> {
    const report = (v: { message?: string; increment?: number }) => void registry.progress.push(v);
    return task({ report }, { isCancellationRequested: false, onCancellationRequested: () => disposable() });
  },
};

export const commands = {
  registerCommand(command: string, handler: Handler) {
    registry.commands.set(command, handler);
    return disposable(() => registry.commands.delete(command));
  },
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    registry.executed.push({ command, args });
    const h = registry.commands.get(command);
    return h ? h(...args) : undefined;
  },
};

export const languages = {
  registerInlineCompletionItemProvider(selector: unknown, provider: unknown) {
    const entry = { selector, provider };
    registry.inlineProviders.push(entry);
    return disposable(() => registry.inlineProviders.splice(registry.inlineProviders.indexOf(entry), 1));
  },
};

export const env = {
  clipboard: {
    async writeText(text: string) {
      registry.clipboard = text;
    },
  },
};

/** Restores the Task 6 mock state (registries, stubs, active editor, config values). */
export function resetMock(): void {
  registry.commands.clear();
  registry.executed.length = 0;
  registry.webviewViews.clear();
  registry.inlineProviders.length = 0;
  registry.outputChannels.length = 0;
  registry.statusBarItems.length = 0;
  registry.terminals.length = 0;
  registry.messages.length = 0;
  registry.clipboard = "";
  registry.configUpdates.length = 0;
  registry.progress.length = 0;
  workspaceFns.applyEdit = defaultApplyEdit;
  workspaceFns.openTextDocument = defaultOpenTextDocument;
  window.activeTextEditor = undefined;
  window.showQuickPick = async () => undefined;
  window.showInputBox = async () => undefined;
  for (const k of Object.keys(configValues)) delete configValues[k];
  workspaceConfigKeys.clear();
}
