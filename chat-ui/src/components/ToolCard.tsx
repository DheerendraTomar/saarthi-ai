import { memo } from "preact/compat";
import { useRef, useState } from "preact/hooks";
import type { ChatToolCall, ChatToolResult, Decision, JsonValue } from "../protocol";
import { Diff } from "./Diff";

export interface ToolCardProps {
  call: ChatToolCall;
  result?: ChatToolResult;
  /**
   * Called at most once. `editedArgs` is the call's full args with the
   * user's edits applied (the core replaces the args wholesale); it is
   * omitted when nothing was edited.
   */
  onDecision(decision: Decision, editedArgs?: JsonValue): void;
}

type ArgsObject = { [key: string]: JsonValue };

function asObject(args: JsonValue): ArgsObject | null {
  return args !== null && typeof args === "object" && !Array.isArray(args) ? args : null;
}

function str(v: JsonValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const SUMMARY_MAX = 120;

/** One-line, human-readable summary of a tool call's arguments. */
export function argsSummary(name: string, args: JsonValue): string {
  const o = asObject(args);
  if (o) {
    const command = str(o.command);
    if (name === "run_command" && command !== undefined) {
      const cwd = str(o.cwd);
      return cwd ? `${command} (in ${cwd})` : command;
    }
    const path = str(o.path);
    if (path !== undefined) {
      const { startLine, endLine } = o;
      if (typeof startLine === "number" || typeof endLine === "number") {
        return `${path}:${typeof startLine === "number" ? startLine : 1}-${typeof endLine === "number" ? endLine : ""}`;
      }
      return path;
    }
    const other = str(o.query) ?? str(o.glob);
    if (other !== undefined) return other;
  }
  const json = JSON.stringify(args) ?? "";
  return json.length > SUMMARY_MAX ? `${json.slice(0, SUMMARY_MAX - 1)}…` : json;
}

const DECISION_LABEL: Record<Decision, string> = {
  once: "Approved",
  always: "Approved (always)",
  deny: "Denied",
};

/**
 * A tool call: name, args summary, preview (a diff for file edits, an
 * editable command line for `run_command`), Approve / Always / Deny while it
 * awaits approval, then the outcome. All model-provided text is rendered as
 * text nodes.
 */
function ToolCardView({ call, result, onDecision }: ToolCardProps) {
  const [decision, setDecision] = useState<Decision | null>(null);
  // Guards against a second click landing before the re-render.
  const decided = useRef(false);
  const args = asObject(call.args);
  const isCommand = call.name === "run_command";
  const isFileEdit = call.name === "edit_file" || call.name === "create_file";
  const originalCommand = str(args?.command) ?? call.preview ?? "";
  const [command, setCommand] = useState(originalCommand);

  const awaiting = call.requiresApproval && !result && decision === null;

  const decide = (d: Decision) => {
    if (!awaiting || decided.current) return;
    decided.current = true;
    setDecision(d);
    const edited = isCommand && d !== "deny" && command !== originalCommand;
    onDecision(d, edited ? { ...(args ?? {}), command } : undefined);
  };

  const state = result
    ? result.ok
      ? "ok"
      : "err"
    : decision === "deny"
      ? "denied"
      : decision
        ? "approved"
        : awaiting
          ? "awaiting"
          : "";
  const summary = argsSummary(call.name, call.args);

  return (
    <div class={`tool-card ${state}`.trim()} data-tool-call-id={call.toolCallId}>
      <div class="tool-head">
        <code class="tool-name">{call.name}</code>
        <span class="tool-args" title={summary}>
          {summary}
        </span>
      </div>
      {isCommand ? (
        <input
          class="tool-command"
          type="text"
          aria-label="Command"
          spellcheck={false}
          value={command}
          readOnly={!awaiting}
          // No Enter-to-approve: a habitual Enter must never run a command.
          onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
        />
      ) : isFileEdit && call.preview ? (
        <Diff diff={call.preview} />
      ) : call.preview ? (
        <pre class="tool-preview">{call.preview}</pre>
      ) : null}
      {awaiting ? (
        <div class="tool-actions">
          <button type="button" aria-label="Approve" onClick={() => decide("once")}>
            Approve
          </button>
          <button
            type="button"
            class="secondary"
            aria-label="Always"
            title="Approve for the rest of this session"
            onClick={() => decide("always")}
          >
            Always
          </button>
          <button type="button" class="secondary" aria-label="Deny" onClick={() => decide("deny")}>
            Deny
          </button>
        </div>
      ) : null}
      {result ? (
        <div class={`tool-result-line ${result.ok ? "ok" : "err"}`} role="status">
          {result.ok ? "✓" : "✗"} {result.summary}
        </div>
      ) : decision ? (
        <div class="tool-pending" role="status">
          {DECISION_LABEL[decision]}
        </div>
      ) : null}
    </div>
  );
}

/** Memoized: callers pass a stable `onDecision`, so streamed tokens skip cards. */
export const ToolCard = memo(ToolCardView);
