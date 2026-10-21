import { useState } from "preact/hooks";
import type { Attachment } from "../protocol";
import type { State } from "../state";

export interface ComposerProps {
  streaming: boolean;
  /** The editor's active file (from `ui/activeFile`); enables the attach toggle. */
  activeFile?: State["activeFile"];
  onSend(text: string, attachments: Attachment[]): void;
  onStop(): void;
}

function basename(uri: string): string {
  const path = uri.replace(/[?#].*$/, "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** The attachment for the active file: its selection when non-empty, else the whole file. */
export function attachmentFor(file: NonNullable<State["activeFile"]>): Attachment {
  const sel = file.selection;
  const empty = !sel || (sel.start.line === sel.end.line && sel.start.character === sel.end.character);
  return empty ? { uri: file.uri } : { uri: file.uri, range: sel };
}

/**
 * Message box: Enter sends, Shift+Enter inserts a newline; Stop while
 * streaming. When the host reports an active file, a toggle attaches it (or
 * its selection) to every send while on.
 */
export function Composer({ streaming, activeFile = null, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(false);

  const send = () => {
    const msg = text.trim();
    if (!msg || streaming) return;
    onSend(msg, attach && activeFile ? [attachmentFor(activeFile)] : []);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const attachment = activeFile ? attachmentFor(activeFile) : null;
  const attachLabel = attachment
    ? `${attachment.range ? "Attach selection" : "Attach current file"} ${basename(attachment.uri)}`
    : "";

  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {attachment ? (
        <div class="composer-context">
          <button
            type="button"
            class={`attach${attach ? " on" : ""}`}
            aria-label={attachLabel}
            aria-pressed={attach}
            title={attachment.uri}
            onClick={() => setAttach(!attach)}
          >
            @ {basename(attachment.uri)}
            {attachment.range ? ` :${attachment.range.start.line + 1}-${attachment.range.end.line + 1}` : ""}
          </button>
        </div>
      ) : null}
      <div class="composer-row">
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
      </div>
    </form>
  );
}
