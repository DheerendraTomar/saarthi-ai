import { memo } from "preact/compat";
import { renderMarkdown } from "../markdown";
import type { Msg } from "../state";

export interface MessageProps {
  msg: Msg;
  /** True for the in-flight assistant message. */
  streaming?: boolean;
}

function Thinking({ text }: { text: string }) {
  return (
    <details class="thinking">
      <summary>Thinking</summary>
      <div class="thinking-body">{text}</div>
    </details>
  );
}

function MessageView({ msg, streaming = false }: MessageProps) {
  switch (msg.kind) {
    case "user":
      return <div class="msg user">{msg.text}</div>;
    case "assistant":
      return (
        <div class={`msg assistant${msg.error ? " error" : ""}${streaming ? " streaming" : ""}`} aria-busy={streaming}>
          {msg.thinking ? <Thinking text={msg.thinking} /> : null}
          {/* renderMarkdown escapes raw HTML and unsafe URLs, so this is safe. */}
          <div class="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }} />
          {msg.error ? (
            <div class="msg-error" role="alert">
              The response failed.
            </div>
          ) : null}
        </div>
      );
    case "toolCall":
      // Placeholder until Task 3's ToolCard.
      return (
        <div class="msg tool-call" data-tool-call-id={msg.toolCallId}>
          Tool call: <code>{msg.name}</code>
        </div>
      );
    case "toolResult":
      return (
        <div class={`msg tool-result ${msg.ok ? "ok" : "err"}`} data-tool-call-id={msg.toolCallId}>
          {msg.ok ? "✓" : "✗"} {msg.summary}
        </div>
      );
  }
}

/**
 * Memoized: `Msg` objects are immutable (the reducer replaces, never mutates),
 * so committed rows skip re-rendering markdown on every streamed token.
 */
export const Message = memo(MessageView);
