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
