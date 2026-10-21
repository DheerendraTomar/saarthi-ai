import { useEffect, useState } from "preact/hooks";
import type { ModelKind } from "../host";
import type { ModelInfo, OllamaState } from "../protocol";
import type { ModelsState } from "../state";

/** Decimal units, as `ollama list` prints them. */
export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function optionLabel(m: ModelInfo, kind: ModelKind): string {
  const parts = [m.name, formatSize(m.sizeBytes)];
  if (kind === "chat" && !m.supportsTools) parts.push("no tools");
  if (kind === "completion" && !m.supportsInsert) parts.push("no fill-in-the-middle");
  return parts.join(" · ");
}

export interface ModelPickerProps {
  kind: ModelKind;
  models: ModelsState | null;
  /** From the `status` notification: a down report also marks a known list stale. */
  ollama: OllamaState | "unknown";
  onSelect(kind: ModelKind, name: string): void;
  /** Render nothing for the "Ollama down" state (the header's status pill already says so). */
  hideDownState?: boolean;
}

const LABEL: Record<ModelKind, string> = { chat: "Chat model", completion: "Completion model" };

/**
 * Lists installed models for one setting. Never an empty silent picker: before
 * the first list it says so, with Ollama down and nothing cached it shows an
 * explicit "Ollama down" state, and with a cached list it marks it stale.
 */
export function ModelPicker({ kind, models, ollama, onSelect, hideDownState }: ModelPickerProps) {
  const current = models?.current[kind] ?? "";
  // The pick shows immediately; the host's next `models/list` confirms it.
  const [selected, setSelected] = useState(current);
  // Every fresh `models/list` resets the pick, so a rejected write cannot stick.
  useEffect(() => setSelected(current), [current, models?.seq]);

  const unavailable =
    (models === null && ollama === "down") ||
    (models !== null && models.list.length === 0 && (models.ollama === "down" || models.error !== undefined));
  if (unavailable) {
    if (hideDownState) return null;
    return (
      <div class={`model-picker down ${kind}`} role="status" title={models?.error ?? "Ollama is not reachable"}>
        No models — Ollama down
      </div>
    );
  }
  if (models === null || models.list.length === 0) {
    return (
      <div class={`model-picker ${kind}`}>
        <select aria-label={LABEL[kind]} disabled>
          <option>{models === null ? "Loading models…" : "No models installed"}</option>
        </select>
      </div>
    );
  }

  const stale = models.stale || ollama === "down";
  const installed = models.list.some((m) => m.name === selected);
  const picked = models.list.find((m) => m.name === selected);
  return (
    <div class={`model-picker ${kind}${stale ? " stale" : ""}`}>
      <select
        aria-label={LABEL[kind]}
        value={selected}
        title={stale ? "Ollama down — showing the last known models" : selected}
        // `input` fires on every selection change (browsers fire it for <select>).
        onInput={(e) => {
          const name = (e.target as HTMLSelectElement).value;
          if (!name || name === selected) return;
          setSelected(name);
          onSelect(kind, name);
        }}
      >
        {!installed && selected ? <option value={selected}>{`${selected} (not installed)`}</option> : null}
        {models.list.map((m) => (
          <option key={m.name} value={m.name}>
            {optionLabel(m, kind)}
          </option>
        ))}
      </select>
      {kind === "completion" && picked && !picked.supportsInsert ? (
        <div class="model-warning" role="note">
          {`${picked.name} does not support fill-in-the-middle; completions may be poor.`}
        </div>
      ) : null}
    </div>
  );
}
