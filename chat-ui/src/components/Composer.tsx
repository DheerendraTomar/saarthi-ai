import { useState } from "preact/hooks";

export interface ComposerProps {
  streaming: boolean;
  onSend(text: string): void;
  onStop(): void;
}

/** Message box: Enter sends, Shift+Enter inserts a newline; Stop while streaming. */
export function Composer({ streaming, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");

  const send = () => {
    const msg = text.trim();
    if (!msg || streaming) return;
    onSend(msg);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        aria-label="Message"
        placeholder="Ask LocalPilot… (Enter to send, Shift+Enter for newline)"
        rows={3}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={onKeyDown}
      />
      {streaming ? (
        <button type="button" class="stop" aria-label="Stop" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button type="submit" aria-label="Send" disabled={!text.trim()}>
          Send
        </button>
      )}
    </form>
  );
}
