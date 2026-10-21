// Chat panel state and the pure reducer that applies host messages and local
// UI events to it. Components render from `State` only.
import type { HostToUi } from "./host";
import type { HistoryMessage, JsonValue, OllamaState, Range, SessionSummary } from "./protocol";

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

/** Placeholder row in v1; Task 3 renders it as a ToolCard. */
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

/** A tool call awaiting the user's approve / always / deny (Task 3 renders it). */
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

export interface State {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  messages: Msg[];
  /** In-flight assistant turn; `null` when idle. */
  streaming: { text: string; thinking: string } | null;
  pendingApprovals: Map<string, ToolCardState>;
  status: { ollama: OllamaState; detail: string };
  pull?: PullState;
  activeFile: { uri: string; selection?: Range } | null;
  /** A short, non-message notice (context full, host error). */
  notice: string | null;
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
    status: { ollama: "ok", detail: "" },
    activeFile: null,
    notice: null,
  };
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
      return {
        ...state,
        messages: [...commitStreaming(state.messages, state.streaming), row],
        // The turn continues after the tool runs: keep an (empty) buffer.
        streaming: { text: "", thinking: "" },
        pendingApprovals,
      };
    }
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
    case "status":
      return { ...state, status: { ollama: event.ollama, detail: event.detail } };
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
    case "ui/error":
      return { ...state, notice: event.message };
    default: {
      // Exhaustiveness: a new HostToUi variant must be handled above.
      const unknown: never = event;
      void unknown;
      return state;
    }
  }
}
