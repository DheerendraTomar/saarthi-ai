// Chat panel state and the pure reducer that applies host messages and local
// UI events to it. Components render from `State` only.
import type { CompletionSettings, HostToUi } from "./host";
import type { CompletionStats, HistoryMessage, JsonValue, ModelInfo, OllamaState, Range, SessionSummary } from "./protocol";

export interface UserMsg {
  kind: "user";
  text: string;
}

export interface AssistantMsg {
  kind: "assistant";
  text: string;
  thinking?: string;
  /** The turn ended with `stopReason: "error"`. */
  error?: true;
}

/** A tool call row; rendered as a ToolCard (live buttons while it is in `pendingApprovals`). */
export interface ToolCallMsg {
  kind: "toolCall";
  toolCallId: string;
  name: string;
  args: JsonValue;
  requiresApproval: boolean;
  preview?: string;
}

export interface ToolResultMsg {
  kind: "toolResult";
  toolCallId: string;
  ok: boolean;
  summary: string;
}

export type Msg = UserMsg | AssistantMsg | ToolCallMsg | ToolResultMsg;

/** A tool call awaiting the user's approve / always / deny. */
export interface ToolCardState {
  toolCallId: string;
  name: string;
  args: JsonValue;
  preview?: string;
}

export interface PullState {
  model: string;
  status: string;
  completed?: number;
  total?: number;
}

export interface ModelsState {
  /** Installed models; the last-known list while Ollama is unreachable. */
  list: ModelInfo[];
  current: { chat: string; completion: string };
  ollama: OllamaState;
  error?: string;
  /** `list` is a cached copy: the latest report was an empty list with Ollama down / an error. */
  stale: boolean;
}

export interface State {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  messages: Msg[];
  /** In-flight assistant turn; `null` when idle. */
  streaming: { text: string; thinking: string } | null;
  pendingApprovals: Map<string, ToolCardState>;
  /** `"unknown"` until the host sends its first `status`. */
  status: { ollama: OllamaState | "unknown"; detail: string };
  pull?: PullState;
  activeFile: { uri: string; selection?: Range } | null;
  /** A short, non-message notice (context full, host error). */
  notice: string | null;
  /** `null` until the host's first `models/list`. */
  models: ModelsState | null;
  /** `null` until the host's first `settings/current`. */
  settings: CompletionSettings | null;
  /** `null` until the host's first `completion/stats`. */
  stats: CompletionStats | null;
  /** Sessions with a turn in progress (any session, not only the current one). */
  runningSessions: string[];
}

/** Whether `sessionId` has a turn in progress (deleting it would be refused). */
export function isSessionRunning(state: State, sessionId: string): boolean {
  return state.runningSessions.includes(sessionId) || (sessionId === state.currentSessionId && state.streaming !== null);
}

/** Events originating in the UI itself (not from the host). */
export type UiEvent =
  | { type: "composer/send"; text: string }
  | { type: "notice/dismiss" };

export const CONTEXT_FULL_NOTICE = "Context window is full — start a new session to continue.";

export function initialState(): State {
  return {
    sessions: [],
    currentSessionId: null,
    messages: [],
    streaming: null,
    pendingApprovals: new Map(),
    status: { ollama: "unknown", detail: "" },
    activeFile: null,
    notice: null,
    models: null,
    settings: null,
    stats: null,
    runningSessions: [],
  };
}

/** Updates `runningSessions`; runs before the current-session filter so other sessions' turns are tracked too. */
function trackRunning(state: State, event: HostToUi | UiEvent): State {
  let id: string | null = null;
  let running = false;
  if (event.type === "composer/send") {
    id = state.currentSessionId;
    running = true;
  } else if (event.type === "chat/turnState") {
    id = event.sessionId;
    running = event.running;
  } else if (event.type === "chat/done" || event.type === "session/deleted") {
    id = event.sessionId;
  }
  if (id === null || state.runningSessions.includes(id) === running) return state;
  const runningSessions = running ? [...state.runningSessions, id] : state.runningSessions.filter((s) => s !== id);
  return { ...state, runningSessions };
}

/** Moves a non-empty streaming buffer into `messages` as an assistant message. */
function commitStreaming(messages: Msg[], streaming: State["streaming"]): Msg[] {
  if (!streaming || (!streaming.text && !streaming.thinking)) return messages;
  const msg: AssistantMsg = { kind: "assistant", text: streaming.text };
  if (streaming.thinking) msg.thinking = streaming.thinking;
  return [...messages, msg];
}

function fromHistory(history: HistoryMessage[]): Msg[] {
  const out: Msg[] = [];
  for (const h of history) {
    if (h.role === "user") {
      out.push({ kind: "user", text: h.content });
    } else if (h.role === "assistant") {
      if (h.content || h.thinking || !h.toolCalls?.length) {
        const msg: AssistantMsg = { kind: "assistant", text: h.content };
        if (h.thinking) msg.thinking = h.thinking;
        out.push(msg);
      }
      for (const c of h.toolCalls ?? []) {
        out.push({ kind: "toolCall", toolCallId: c.toolCallId, name: c.name, args: c.args, requiresApproval: false });
      }
    } else {
      out.push({ kind: "toolResult", toolCallId: h.toolCallId ?? "", ok: true, summary: h.content });
    }
  }
  return out;
}

/**
 * Applies one host message or UI event. Pure: never mutates `state`.
 * Turn events (`chat/*`) for a session other than the current one are ignored
 * (when no session is known yet, every session is accepted).
 */
export function reduce(state: State, event: HostToUi | UiEvent): State {
  state = trackRunning(state, event);
  if ("sessionId" in event && event.type.startsWith("chat/")) {
    if (state.currentSessionId !== null && event.sessionId !== state.currentSessionId) return state;
  }
  switch (event.type) {
    case "composer/send":
      return {
        ...state,
        messages: [...commitStreaming(state.messages, state.streaming), { kind: "user", text: event.text }],
        streaming: { text: "", thinking: "" },
        notice: null,
      };
    case "notice/dismiss":
      return { ...state, notice: null };
    case "chat/token": {
      const cur = state.streaming ?? { text: "", thinking: "" };
      const streaming =
        event.kind === "thinking"
          ? { ...cur, thinking: cur.thinking + event.delta }
          : { ...cur, text: cur.text + event.delta };
      return { ...state, streaming };
    }
    case "chat/toolCall": {
      const row: ToolCallMsg = {
        kind: "toolCall",
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
        requiresApproval: event.requiresApproval,
      };
      if (event.preview !== undefined) row.preview = event.preview;
      let pendingApprovals = state.pendingApprovals;
      if (event.requiresApproval) {
        pendingApprovals = new Map(pendingApprovals);
        const card: ToolCardState = { toolCallId: event.toolCallId, name: event.name, args: event.args };
        if (event.preview !== undefined) card.preview = event.preview;
        pendingApprovals.set(event.toolCallId, card);
      }
      // A call already shown (replayed from history, then re-sent by the host
      // because it still awaits approval) is updated in place, not duplicated.
      const at = state.messages.findIndex((m) => m.kind === "toolCall" && m.toolCallId === event.toolCallId);
      const messages = at >= 0 ? state.messages.map((m, i) => (i === at ? row : m)) : [...commitStreaming(state.messages, state.streaming), row];
      return {
        ...state,
        messages,
        // The turn continues after the tool runs: keep an (empty) buffer.
        streaming: at >= 0 ? (state.streaming ?? { text: "", thinking: "" }) : { text: "", thinking: "" },
        pendingApprovals,
      };
    }
    case "chat/turnState":
      // Running: keep or open an (empty) buffer so the composer offers Stop.
      if (event.running) return state.streaming ? state : { ...state, streaming: { text: "", thinking: "" } };
      return { ...state, messages: commitStreaming(state.messages, state.streaming), streaming: null };
    case "chat/toolResult": {
      let pendingApprovals = state.pendingApprovals;
      if (pendingApprovals.has(event.toolCallId)) {
        pendingApprovals = new Map(pendingApprovals);
        pendingApprovals.delete(event.toolCallId);
      }
      return {
        ...state,
        messages: [
          ...commitStreaming(state.messages, state.streaming),
          { kind: "toolResult", toolCallId: event.toolCallId, ok: event.ok, summary: event.summary },
        ],
        streaming: state.streaming ? { text: "", thinking: "" } : null,
        pendingApprovals,
      };
    }
    case "chat/done": {
      let messages = commitStreaming(state.messages, state.streaming);
      let notice = state.notice;
      if (event.stopReason === "error") {
        const last = messages[messages.length - 1];
        // The errored turn is the trailing assistant row; if the turn produced
        // no assistant text after the user's message, add an empty one.
        if (last && last.kind === "assistant") {
          messages = [...messages.slice(0, -1), { ...last, error: true }];
        } else {
          messages = [...messages, { kind: "assistant", text: "", error: true }];
        }
      } else if (event.stopReason === "contextFull") {
        notice = CONTEXT_FULL_NOTICE;
      }
      return { ...state, messages, streaming: null, pendingApprovals: new Map(), notice };
    }
    case "status": {
      // A failed pull sends no final progress; any status report ends the
      // progress display (an ongoing pull re-sets it on its next event).
      const next: State = { ...state, status: { ollama: event.ollama, detail: event.detail } };
      delete next.pull;
      return next;
    }
    case "ollama/pullProgress": {
      if (event.status === "success") {
        const next = { ...state };
        delete next.pull;
        return next;
      }
      const pull: PullState = { model: event.model, status: event.status };
      if (event.completed !== undefined) pull.completed = event.completed;
      if (event.total !== undefined) pull.total = event.total;
      return { ...state, pull };
    }
    case "session/list":
      return { ...state, sessions: event.sessions, currentSessionId: event.current };
    case "session/history":
      return {
        ...state,
        currentSessionId: event.sessionId,
        messages: fromHistory(event.messages),
        streaming: null,
        pendingApprovals: new Map(),
        notice: null,
      };
    case "ui/activeFile":
      return {
        ...state,
        activeFile: event.uri === null ? null : event.selection ? { uri: event.uri, selection: event.selection } : { uri: event.uri },
      };
    case "ui/error": {
      const next: State = { ...state, notice: event.message };
      delete next.pull;
      return next;
    }
    case "ui/theme":
      return state; // applied to the document by App (applyTheme)
    case "models/list": {
      const unavailable = event.models.length === 0 && (event.ollama === "down" || event.error !== undefined);
      // Never trade a known list for an empty one just because Ollama is unreachable.
      const keep = unavailable && state.models !== null && state.models.list.length > 0;
      const models: ModelsState = {
        list: keep && state.models ? state.models.list : event.models,
        current: event.current,
        ollama: event.ollama,
        stale: keep,
      };
      if (event.error !== undefined) models.error = event.error;
      return { ...state, models };
    }
    case "settings/current":
      return { ...state, settings: event.settings };
    case "completion/stats":
      return { ...state, stats: event.stats };
    case "session/deleted": {
      const sessions = state.sessions.filter((s) => s.sessionId !== event.sessionId);
      if (event.sessionId !== state.currentSessionId) return { ...state, sessions };
      // The open session is gone: clear the view; App asks the host to open `next` (or a new one).
      return {
        ...state,
        sessions,
        currentSessionId: event.next,
        messages: [],
        streaming: null,
        pendingApprovals: new Map(),
        notice: null,
      };
    }
    default: {
      // Exhaustiveness: a new HostToUi variant must be handled above.
      const unknown: never = event;
      void unknown;
      return state;
    }
  }
}
