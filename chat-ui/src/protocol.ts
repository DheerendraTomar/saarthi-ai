// TypeScript mirror of the core's wire types (core/src/protocol.rs).
// All keys and enum strings are camelCase exactly as serialized by the core.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Zero-based; `character` is in UTF-16 code units. */
export interface Position {
  line: number;
  character: number;
}

/** Half-open range `[start, end)`. */
export interface Range {
  start: Position;
  end: Position;
}

export interface Attachment {
  uri: string;
  range?: Range;
}

export type Decision = "once" | "always" | "deny";

export type TokenKind = "text" | "thinking";

export type StopReason = "done" | "stopped" | "error" | "contextFull";

export type OllamaState = "ok" | "down" | "modelMissing";

/** Notification `chat/token`. */
export interface ChatToken {
  sessionId: string;
  delta: string;
  kind: TokenKind;
}

/** Notification `chat/toolCall`. `preview` is a unified diff or command line. */
export interface ChatToolCall {
  sessionId: string;
  toolCallId: string;
  name: string;
  args: JsonValue;
  requiresApproval: boolean;
  preview?: string;
}

/** Notification `chat/toolResult`. */
export interface ChatToolResult {
  sessionId: string;
  toolCallId: string;
  ok: boolean;
  summary: string;
}

/** Notification `chat/done` — the only signal that a turn has finished. */
export interface ChatDone {
  sessionId: string;
  stopReason: StopReason;
}

/** Notification `status`. */
export interface StatusNotification {
  ollama: OllamaState;
  detail: string;
}

/** Notification `ollama/pullProgress`. */
export interface OllamaPullProgress {
  model: string;
  status: string;
  completed?: number;
  total?: number;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  /** Milliseconds since the Unix epoch. */
  updatedAtMs: number;
}

export interface HistoryToolCall {
  toolCallId: string;
  name: string;
  args: JsonValue;
}

/** One persisted message, for replaying a session. */
export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  /** Present on `"tool"` messages: the call this is the result of. */
  toolCallId?: string;
  /** Tool calls made by an `"assistant"` message (omitted when empty). */
  toolCalls?: HistoryToolCall[];
}
