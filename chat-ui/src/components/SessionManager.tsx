import { useState } from "preact/hooks";
import type { SessionSummary } from "../protocol";
import { TrashIcon } from "./icons";

export const RUNNING_REASON = "This session's turn is running — stop it before deleting.";

export interface SessionManagerProps {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  isRunning(sessionId: string): boolean;
  onSwitch(sessionId: string): void;
  onDelete(sessionId: string): void;
  onClearAll(): void;
}

export function SessionManager({ sessions, currentSessionId, isRunning, onSwitch, onDelete, onClearAll }: SessionManagerProps) {
  const [confirming, setConfirming] = useState(false);
  const anyRunning = sessions.some((s) => isRunning(s.sessionId));
  return (
    <section class="panel session-manager" aria-label="Manage sessions">
      {sessions.length === 0 ? <p class="muted">No sessions yet.</p> : null}
      <ul class="session-list" aria-label="Sessions">
        {sessions.map((s) => {
          const title = s.title || "Untitled";
          const running = isRunning(s.sessionId);
          const current = s.sessionId === currentSessionId;
          return (
            <li key={s.sessionId} class={current ? "current" : undefined}>
              <button
                type="button"
                class="session-title"
                aria-current={current ? "true" : undefined}
                onClick={() => {
                  if (!current) onSwitch(s.sessionId);
                }}
              >
                {title}
              </button>
              {running ? (
                <span class="running-badge" title={RUNNING_REASON}>
                  Running
                </span>
              ) : null}
              <span class="delete-wrap" title={running ? RUNNING_REASON : undefined}>
                <button
                  type="button"
                  class="icon secondary"
                  aria-label={`Delete session "${title}"`}
                  title={running ? RUNNING_REASON : "Delete session"}
                  disabled={running}
                  onClick={() => {
                    if (!running) onDelete(s.sessionId);
                  }}
                >
                  <TrashIcon />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {confirming ? (
        <div class="confirm" role="alertdialog" aria-label="Confirm clear all">
          <span>Delete all sessions?</span>
          {anyRunning ? <span class="muted">Running sessions are kept.</span> : null}
          <button
            type="button"
            class="danger"
            onClick={() => {
              setConfirming(false);
              onClearAll();
            }}
          >
            Delete all
          </button>
          <button type="button" class="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" class="secondary" disabled={sessions.length === 0} onClick={() => setConfirming(true)}>
          Clear all
        </button>
      )}
    </section>
  );
}
