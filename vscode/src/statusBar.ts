import * as vscode from "vscode";
import type { StatusNotification } from "./chat/chatView";
import type { CoreState } from "./rpc/coreClient";

export const STATUS_MENU_COMMAND = "localpilot.statusMenu";

/**
 * The "LocalPilot" status-bar item. What it shows, most important first:
 * a stopped core, Ollama down / model missing, completions
 * paused (by the user, or while a chat reply is generating), otherwise all good. Clicking it opens the LocalPilot quick pick.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private status?: StatusNotification;
  private coreState: CoreState = "stopped";
  private coreError?: string;
  private completionsEnabled = true;
  private chatActive = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = STATUS_MENU_COMMAND;
    this.render();
    this.item.show();
  }

  /** What a click runs (undefined: nothing, e.g. in a window with no folder). */
  setCommand(command: string | undefined): void {
    this.item.command = command;
  }

  get text(): string {
    return this.item.text;
  }

  get ollama(): StatusNotification["ollama"] | undefined {
    return this.status?.ollama;
  }

  setStatus(status: StatusNotification): void {
    this.status = status;
    this.render();
  }

  setCoreState(state: CoreState, error?: string): void {
    this.coreState = state;
    this.coreError = state === "crashed" ? error ?? this.coreError : undefined;
    this.render();
  }

  setCompletionsEnabled(enabled: boolean): void {
    this.completionsEnabled = enabled;
    this.render();
  }

  /** A chat turn is running: the core answers completions with nothing until it ends (spec §5(10)). */
  setChatActive(active: boolean): void {
    this.chatActive = active;
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    const warning = new vscode.ThemeColor("statusBarItem.warningBackground");
    let text = "$(sparkle) LocalPilot";
    let tooltip = "LocalPilot: running locally via Ollama";
    let background: vscode.ThemeColor | undefined;
    if (this.coreState === "crashed") {
      text = "$(error) LocalPilot stopped";
      tooltip = `LocalPilot core is not running${this.coreError ? `: ${this.coreError}` : ""}. Click to restart.`;
      background = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (this.status?.ollama === "down") {
      text = "$(warning) Ollama down";
      tooltip = `LocalPilot: ${this.status.detail}. Click to start Ollama or retry.`;
      background = warning;
    } else if (this.status?.ollama === "modelMissing") {
      text = "$(warning) Model missing";
      tooltip = `LocalPilot: ${this.status.detail}. Run "ollama pull <model>" in a terminal.`;
      background = warning;
    } else if (!this.completionsEnabled) {
      text = "$(debug-pause) completions paused";
      tooltip = "LocalPilot inline completions are paused. Click to resume.";
    } else if (this.chatActive) {
      text = "$(debug-pause) completions paused during chat";
      tooltip = "LocalPilot: inline completions resume when the chat reply finishes (chat and completions share the GPU).";
    } else if (this.coreState === "starting") {
      tooltip = "LocalPilot: starting…";
    }
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.backgroundColor = background;
  }
}
