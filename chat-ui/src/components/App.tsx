import { memo } from "preact/compat";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import { applyTheme, type CompletionSettings, type HostBridge, type ModelKind } from "../host";
import type { Attachment, ChatToolResult, Decision, JsonValue, OllamaState } from "../protocol";
import { initialState, isSessionRunning, reduce } from "../state";
import type { State } from "../state";
import { Composer } from "./Composer";
import { GearIcon, ListIcon } from "./icons";
import { Message } from "./Message";
import type { CodeAction } from "./Message";
import { ModelPicker } from "./ModelPicker";
import { SessionManager } from "./SessionManager";
import { SettingsPanel } from "./SettingsPanel";
import { ToolCard } from "./ToolCard";

export interface AppProps {
  bridge: HostBridge;
}

/** Within this distance of the bottom, the message list follows new output. */
const STICK_THRESHOLD_PX = 40;

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

type Panel = "sessions" | "settings" | null;

interface SessionSwitcherProps extends Pick<State, "sessions" | "currentSessionId"> {
  bridge: HostBridge;
  managing: boolean;
  onToggleManage(): void;
}

function SessionSwitcher({ sessions, currentSessionId, bridge, managing, onToggleManage }: SessionSwitcherProps) {
  const known = currentSessionId !== null && sessions.some((s) => s.sessionId === currentSessionId);
  return (
    <div class="sessions">
      <select
        aria-label="Session"
        value={known ? currentSessionId : ""}
        // `input` fires on every selection change (browsers fire it for <select>).
        onInput={(e) => {
          const sessionId = (e.target as HTMLSelectElement).value;
          if (sessionId && sessionId !== currentSessionId) bridge.post({ type: "chat/switchSession", sessionId });
        }}
      >
        {known ? null : (
          <option value="" disabled>
            New session
          </option>
        )}
        {sessions.map((s) => (
          <option key={s.sessionId} value={s.sessionId}>
            {s.title || "Untitled"}
          </option>
        ))}
      </select>
      <button
        type="button"
        class="secondary"
        aria-label="New session"
        title="New session"
        onClick={() => bridge.post({ type: "chat/newSession" })}
      >
        New
      </button>
      <button
        type="button"
        class={`icon secondary${managing ? " on" : ""}`}
        aria-label="Manage sessions"
        aria-pressed={managing}
        title="Manage sessions"
        onClick={onToggleManage}
      >
        <ListIcon />
      </button>
    </div>
  );
}

interface ToolCallRowProps {
  msg: Extract<State["messages"][number], { kind: "toolCall" }>;
  sessionId: string;
  awaiting: boolean;
  result: ChatToolResult | undefined;
  onDecision(toolCallId: string, decision: Decision, editedArgs?: JsonValue): void;
}

function ToolCallRowView({ msg, sessionId, awaiting, result, onDecision }: ToolCallRowProps) {
  const call = useMemo(
    () => ({
      sessionId,
      toolCallId: msg.toolCallId,
      name: msg.name,
      args: msg.args,
      requiresApproval: awaiting,
      ...(msg.preview !== undefined ? { preview: msg.preview } : {}),
    }),
    [msg, sessionId, awaiting],
  );
  const decide = useCallback(
    (decision: Decision, editedArgs?: JsonValue) => onDecision(msg.toolCallId, decision, editedArgs),
    [onDecision, msg.toolCallId],
  );
  return <ToolCard call={call} result={result} onDecision={decide} />;
}

const ToolCallRow = memo(ToolCallRowView);

export function App({ bridge }: AppProps) {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const listRef = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<Panel>(null);

  useEffect(() => {
    // Mirrors of state the handler needs synchronously (several host messages
    // can arrive before a re-render, e.g. one `session/deleted` per cleared session).
    let current: string | null = null;
    let ollama: OllamaState | null = null;
    const off = bridge.onMessage((msg) => {
      if (msg.type === "ui/theme") applyTheme(msg.vars);
      if (msg.type === "session/list") current = msg.current;
      else if (msg.type === "session/history") current = msg.sessionId;
      else if (msg.type === "session/deleted" && msg.sessionId === current) {
        current = msg.next;
        bridge.post(msg.next === null ? { type: "chat/newSession" } : { type: "chat/switchSession", sessionId: msg.next });
      } else if (msg.type === "status") {
        // First report, Ollama came back or a pull finished: (re)load the installed models.
        if (msg.ollama === "ok" && ollama !== "ok") bridge.post({ type: "models/list" });
        ollama = msg.ollama;
      }
      dispatch(msg);
    });
    bridge.post({ type: "ui/ready" });
    return off;
  }, [bridge]);

  // Keep the newest output in view while streaming, unless the user scrolled up to read.
  const stickToBottom = useRef(true);
  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  }, []);
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.streaming]);

  const onSend = (text: string, attachments: Attachment[]) => {
    dispatch({ type: "composer/send", text });
    bridge.post({ type: "chat/send", message: text, attachments });
  };

  // Stable callbacks so memoized rows and cards skip re-rendering per token.
  const onCodeAction = useCallback(
    (action: CodeAction, text: string) =>
      bridge.post(action === "copy" ? { type: "ui/copy", text } : { type: "ui/insertAtCursor", text }),
    [bridge],
  );
  const onDecision = useCallback(
    (toolCallId: string, decision: Decision, editedArgs?: JsonValue) =>
      bridge.post(
        editedArgs === undefined
          ? { type: "chat/approve", toolCallId, decision }
          : { type: "chat/approve", toolCallId, decision, editedArgs },
      ),
    [bridge],
  );

  const onSelectModel = useCallback((kind: ModelKind, name: string) => bridge.post({ type: "model/select", kind, name }), [bridge]);
  const onPatch = useCallback((patch: Partial<CompletionSettings>) => bridge.post({ type: "settings/set", patch }), [bridge]);
  const onResetLearning = useCallback(() => {
    bridge.post({ type: "completion/resetLearning" });
    bridge.post({ type: "completion/stats" });
  }, [bridge]);
  const togglePanel = (p: Exclude<Panel, null>) => {
    const next = panel === p ? null : p;
    setPanel(next);
    if (next === "settings") {
      bridge.post({ type: "settings/get" });
      bridge.post({ type: "completion/stats" });
      bridge.post({ type: "models/list" });
    }
  };

  // Results are their own rows in `messages`; join them into their cards.
  const results = useMemo(() => {
    const calls = new Set<string>();
    const byId = new Map<string, ChatToolResult>();
    for (const m of state.messages) {
      if (m.kind === "toolCall") calls.add(m.toolCallId);
      else if (m.kind === "toolResult" && calls.has(m.toolCallId)) {
        byId.set(m.toolCallId, { sessionId: state.currentSessionId ?? "", toolCallId: m.toolCallId, ok: m.ok, summary: m.summary });
      }
    }
    return byId;
  }, [state.messages, state.currentSessionId]);

  const { streaming } = state;
  return (
    <div class="app">
      <header class="header">
        <SessionSwitcher
          sessions={state.sessions}
          currentSessionId={state.currentSessionId}
          bridge={bridge}
          managing={panel === "sessions"}
          onToggleManage={() => togglePanel("sessions")}
        />
        <div class="header-right">
          <ModelPicker kind="chat" models={state.models} ollama={state.status.ollama} onSelect={onSelectModel} />
          <button
            type="button"
            class={`icon secondary${panel === "settings" ? " on" : ""}`}
            aria-label="Settings"
            aria-pressed={panel === "settings"}
            title="Completion settings"
            onClick={() => togglePanel("settings")}
          >
            <GearIcon />
          </button>
          <StatusPill status={state.status} pull={state.pull} bridge={bridge} />
        </div>
      </header>
      {panel === "sessions" ? (
        <SessionManager
          sessions={state.sessions}
          currentSessionId={state.currentSessionId}
          isRunning={(id) => isSessionRunning(state, id)}
          onSwitch={(sessionId) => bridge.post({ type: "chat/switchSession", sessionId })}
          onDelete={(sessionId) => bridge.post({ type: "session/delete", sessionId })}
          onClearAll={() => bridge.post({ type: "session/clearAll" })}
        />
      ) : null}
      {panel === "settings" ? (
        <SettingsPanel
          settings={state.settings}
          stats={state.stats}
          models={state.models}
          ollama={state.status.ollama}
          onPatch={onPatch}
          onSelectModel={onSelectModel}
          onResetLearning={onResetLearning}
        />
      ) : null}
      <div class="messages" ref={listRef} role="log" aria-live="polite" onScroll={onScroll}>
        {state.messages.map((m, i) => {
          if (m.kind === "toolCall") {
            return (
              <ToolCallRow
                // Keyed by identity so a card's local decision / edited command
                // never carries over to another session's row at the same index.
                key={`tool:${state.currentSessionId ?? ""}:${m.toolCallId}`}
                msg={m}
                sessionId={state.currentSessionId ?? ""}
                // Approval is only possible while the core still awaits it
                // (chat/done and session switches clear pending approvals).
                awaiting={m.requiresApproval && state.pendingApprovals.has(m.toolCallId)}
                result={results.get(m.toolCallId)}
                onDecision={onDecision}
              />
            );
          }
          if (m.kind === "toolResult" && results.has(m.toolCallId)) return null;
          return <Message key={i} msg={m} onCodeAction={onCodeAction} />;
        })}
        {streaming && (streaming.text || streaming.thinking) ? (
          <Message
            msg={{ kind: "assistant", text: streaming.text, ...(streaming.thinking ? { thinking: streaming.thinking } : {}) }}
            streaming
            onCodeAction={onCodeAction}
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
      <Composer streaming={streaming !== null} activeFile={state.activeFile} onSend={onSend} onStop={() => bridge.post({ type: "chat/stop" })} />
    </div>
  );
}
