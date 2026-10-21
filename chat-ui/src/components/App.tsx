import { useEffect, useReducer, useRef } from "preact/hooks";
import type { HostBridge } from "../host";
import { initialState, reduce } from "../state";
import type { State } from "../state";
import { Composer } from "./Composer";
import { Message } from "./Message";

export interface AppProps {
  bridge: HostBridge;
}

/** Model name from a `modelMissing` detail such as `model "x:1b" is not installed`. */
export function modelFromDetail(detail: string): string {
  return /"([^"]+)"/.exec(detail)?.[1] ?? "";
}

function StatusPill({ status, pull, bridge }: Pick<State, "status" | "pull"> & { bridge: HostBridge }) {
  if (pull) {
    const pct = pull.total ? ` ${Math.floor(((pull.completed ?? 0) / pull.total) * 100)}%` : "";
    return (
      <div class="status-pill pulling" role="status">
        Pulling {pull.model}: {pull.status}
        {pct}
      </div>
    );
  }
  if (status.ollama === "down") {
    return (
      <div class="status-pill down" role="status" title={status.detail}>
        <span>Ollama down</span>
        <button type="button" aria-label="Start Ollama" onClick={() => bridge.post({ type: "ollama/start" })}>
          Start Ollama
        </button>
      </div>
    );
  }
  if (status.ollama === "modelMissing") {
    return (
      <div class="status-pill missing" role="status" title={status.detail}>
        <span>Model missing</span>
        <button
          type="button"
          aria-label="Pull model"
          onClick={() => bridge.post({ type: "ollama/pull", model: modelFromDetail(status.detail) })}
        >
          Pull model
        </button>
      </div>
    );
  }
  if (status.ollama === "unknown") {
    return (
      <div class="status-pill unknown" role="status">
        Checking Ollama…
      </div>
    );
  }
  return (
    <div class="status-pill ok" role="status" title={status.detail}>
      Ollama ready
    </div>
  );
}

export function App({ bridge }: AppProps) {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = bridge.onMessage(dispatch);
    bridge.post({ type: "ui/ready" });
    return off;
  }, [bridge]);

  // Keep the newest output in view while streaming.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.streaming]);

  const onSend = (text: string) => {
    dispatch({ type: "composer/send", text });
    bridge.post({ type: "chat/send", message: text, attachments: [] });
  };

  const { streaming } = state;
  return (
    <div class="app">
      <header class="header">
        {/* Task 3: session switcher (state.sessions / state.currentSessionId). */}
        <StatusPill status={state.status} pull={state.pull} bridge={bridge} />
      </header>
      <div class="messages" ref={listRef} role="log" aria-live="polite">
        {state.messages.map((m, i) => (
          <Message key={i} msg={m} />
        ))}
        {streaming && (streaming.text || streaming.thinking) ? (
          <Message
            msg={{ kind: "assistant", text: streaming.text, ...(streaming.thinking ? { thinking: streaming.thinking } : {}) }}
            streaming
          />
        ) : null}
      </div>
      {state.notice ? (
        <div class="notice" role="alert">
          <span>{state.notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dispatch({ type: "notice/dismiss" })}>
            ×
          </button>
        </div>
      ) : null}
      <Composer streaming={streaming !== null} onSend={onSend} onStop={() => bridge.post({ type: "chat/stop" })} />
    </div>
  );
}
