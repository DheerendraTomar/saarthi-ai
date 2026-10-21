import { Widget } from '@lumino/widgets';
import type { ConnectionState, OllamaStatus } from './client';

type Tone = 'normal' | 'warning' | 'error';

/**
 * The "LocalPilot" status-bar item, with the VS Code extension's texts and
 * precedence (most important first): a running pull, a stopped core, Ollama
 * down / model missing, completions paused (by the user, or while a chat reply
 * is generating), otherwise all good. While the WebSocket (re)connects it
 * reads "LocalPilot" like VS Code's "starting"; when the server extension is
 * not reachable at all (`error`) it reads "LocalPilot unreachable". A click
 * opens the LocalPilot command menu (`setOnClick`), so every tooltip names the
 * menu entry that helps rather than promising the click does it.
 */
export class StatusItem extends Widget {
  private status?: OllamaStatus;
  private connection: ConnectionState = 'connecting';
  private coreError?: string;
  private pullPercent?: number;
  private completionsEnabled = true;
  private chatActive = false;
  private onClick?: () => void;
  private _text = '';
  private _tooltip = '';

  constructor() {
    super();
    this.addClass('jp-LocalPilotStatus');
    this.node.addEventListener('click', this.handleClick);
    this.render();
  }

  get text(): string {
    return this._text;
  }

  get tooltip(): string {
    return this._tooltip;
  }

  get ollama(): OllamaStatus | undefined {
    return this.status;
  }

  setOnClick(onClick: (() => void) | undefined): void {
    this.onClick = onClick;
  }

  setStatus(status: OllamaStatus): void {
    this.status = status;
    this.render();
  }

  /** `error` explains `crashed` (the server refused initialize) and the `error` state (unreachable). */
  setConnectionState(state: ConnectionState, error?: string): void {
    this.connection = state;
    this.coreError = state === 'crashed' || state === 'error' ? (error ?? this.coreError) : undefined;
    this.render();
  }

  /** Pull progress in percent (0–100), or undefined when no pull is running. */
  setPull(percent: number | undefined): void {
    this.pullPercent = percent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(percent)));
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
    this.node.removeEventListener('click', this.handleClick);
    super.dispose();
  }

  private readonly handleClick = () => this.onClick?.();

  private render(): void {
    let text = 'LocalPilot';
    let tooltip = 'LocalPilot: running locally via Ollama. Click for LocalPilot commands.';
    let tone: Tone = 'normal';
    if (this.pullPercent !== undefined) {
      text = `Pulling ${this.pullPercent}%`;
      tooltip = 'LocalPilot: pulling a model. Click for LocalPilot commands.';
    } else if (this.connection === 'error') {
      text = 'LocalPilot unreachable';
      tooltip =
        `${this.coreError ?? 'LocalPilot server extension not reachable'}. ` +
        'Run `jupyter server extension list` and see the README. Click for LocalPilot commands (Restart LocalPilot Core retries).';
      tone = 'error';
    } else if (this.connection === 'crashed' || this.connection === 'disposed') {
      text = 'LocalPilot stopped';
      tooltip = `LocalPilot core is not running${this.coreError ? `: ${this.coreError}` : ''}. Click for LocalPilot commands (Restart LocalPilot Core).`;
      tone = 'error';
    } else if (this.status?.ollama === 'down') {
      text = 'Ollama down';
      tooltip = `LocalPilot: ${this.status.detail}. Click for LocalPilot commands (Start Ollama).`;
      tone = 'warning';
    } else if (this.status?.ollama === 'modelMissing') {
      text = 'Model missing';
      tooltip = `LocalPilot: ${this.status.detail}. Click for LocalPilot commands (Pull Model with Ollama).`;
      tone = 'warning';
    } else if (!this.completionsEnabled) {
      text = 'completions paused';
      tooltip = 'LocalPilot inline completions are paused. Click for LocalPilot commands (Resume Inline Completions).';
    } else if (this.chatActive) {
      text = 'completions paused during chat';
      tooltip = 'LocalPilot: inline completions resume when the chat reply finishes (chat and completions share the GPU).';
    } else if (this.connection === 'connecting' || this.connection === 'idle') {
      tooltip = 'LocalPilot: connecting to the Jupyter server…';
    } else if (this.connection === 'reconnecting') {
      tooltip = 'LocalPilot: connection to the Jupyter server lost; reconnecting…';
    }
    this._text = text;
    this._tooltip = tooltip;
    this.node.textContent = text;
    this.node.title = tooltip;
    this.toggleClass('jp-LocalPilotStatus-warning', tone === 'warning');
    this.toggleClass('jp-LocalPilotStatus-error', tone === 'error');
  }
}
