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

/** One installed model, from `ollama/models`. */
export interface ModelInfo {
  name: string;
  sizeBytes: number;
  family?: string;
  /** The model's template supports fill-in-the-middle (`insert`), needed for completions. */
  supportsInsert: boolean;
  supportsTools: boolean;
}

/** Per-language entry of `completion/stats`. */
export interface CompletionLanguageStats {
  served: number;
  accepted: number;
  partial: number;
  rejected: number;
  typedThrough: number;
  /** (accepted + partial) / served, in [0, 1]; 0 when nothing was served. */
  acceptRate: number;
  learnedMaxLines: number;
  learnedNumPredict: number;
  /** The two limits above were learned from outcomes; `false`: the configured defaults (< 10 outcomes or adaptive off). */
  learned: boolean;
  /** Style examples the next snippet refresh inserts. */
  examples: number;
}

/** Result of `completion/stats`. */
export interface CompletionStats {
  languages: Record<string, CompletionLanguageStats>;
  /** `null` before the core is initialized with a workspace. */
  logPath: string | null;
  adaptive: boolean;
}
