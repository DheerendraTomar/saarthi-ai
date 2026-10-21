import { useEffect, useRef, useState } from "preact/hooks";
import type { CompletionSettings, ModelKind, SettingsPatch } from "../host";
import type { CompletionStats, OllamaState } from "../protocol";
import type { ModelsState } from "../state";
import { ModelPicker } from "./ModelPicker";

interface NumberFieldProps {
  id: string;
  label: string;
  value: number;
  min: number;
  /** `settingsSeq`: every `settings/current` resets the field, so a rejected write cannot stick. */
  seq: number;
  onCommit(value: number): void;
}

/**
 * Commits on the native `change` event (blur / Enter), not per keystroke —
 * every commit is a settings write that may restart the core. An integer
 * ≥ `min` is posted; anything else reverts to the current value.
 * (preact/compat maps `onChange` to `input` for number inputs, hence the
 * listener on the element.)
 */
function NumberField({ id, label, value, min, seq, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value, seq]);
  const ref = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, min, onCommit });
  latest.current = { value, min, onCommit };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const commit = () => {
      const { value, min, onCommit } = latest.current;
      const raw = el.value.trim();
      const n = Number(raw);
      if (raw === "" || !Number.isInteger(n) || n < min) {
        el.value = String(value);
        setDraft(String(value));
        return;
      }
      setDraft(raw);
      if (n !== value) onCommit(n);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, []);
  return (
    <div class="setting">
      <label for={id}>{label}</label>
      <input
        ref={ref}
        id={id}
        type="number"
        min={min}
        step={1}
        value={draft}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      />
    </div>
  );
}

function StatsTable({ stats }: { stats: CompletionStats }) {
  const langs = Object.entries(stats.languages).sort((a, b) => b[1].served - a[1].served || a[0].localeCompare(b[0]));
  if (langs.length === 0) return <p class="muted">No completions recorded yet.</p>;
  return (
    <table class="stats" aria-label="Completion stats">
      <thead>
        <tr>
          <th scope="col">Language</th>
          <th scope="col">Served</th>
          <th scope="col">Accepted</th>
          <th scope="col">Accept rate</th>
          <th scope="col" title="Learned multi-line cap">Lines</th>
          <th scope="col" title="Learned num_predict">Tokens</th>
          <th scope="col" title="Style examples in the prompt">Examples</th>
        </tr>
      </thead>
      <tbody>
        {langs.map(([lang, s]) => (
          <tr key={lang}>
            <td>{lang}</td>
            <td>{String(s.served)}</td>
            <td>{String(s.accepted)}</td>
            <td>{`${Math.round(s.acceptRate * 100)}%`}</td>
            <td>{String(s.learnedMaxLines)}</td>
            <td>{String(s.learnedNumPredict)}</td>
            <td>{String(s.examples)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface SettingsPanelProps {
  settings: CompletionSettings | null;
  settingsSeq: number;
  stats: CompletionStats | null;
  models: ModelsState | null;
  ollama: OllamaState | "unknown";
  onPatch(patch: SettingsPatch): void;
  onSelectModel(kind: ModelKind, name: string): void;
  onResetLearning(): void;
}

export function SettingsPanel({ settings, settingsSeq, stats, models, ollama, onPatch, onSelectModel, onResetLearning }: SettingsPanelProps) {
  return (
    <section class="panel settings-panel" aria-label="Completion settings">
      <h2>Completions</h2>
      <div class="setting">
        <span class="setting-label">Completion model</span>
        <ModelPicker kind="completion" models={models} ollama={ollama} onSelect={onSelectModel} />
      </div>
      {settings ? (
        <>
          <NumberField
            id="lp-max-tokens"
            label="Max tokens"
            value={settings.completionMaxTokens}
            min={1}
            seq={settingsSeq}
            onCommit={(v) => onPatch({ completionMaxTokens: v })}
          />
          <NumberField
            id="lp-debounce"
            label="Debounce (ms)"
            value={settings.completionDebounceMs}
            min={0}
            seq={settingsSeq}
            onCommit={(v) => onPatch({ completionDebounceMs: v })}
          />
          <NumberField
            id="lp-context"
            label="Context budget (tokens)"
            value={settings.completionContextTokens}
            min={1}
            seq={settingsSeq}
            onCommit={(v) => onPatch({ completionContextTokens: v })}
          />
          <div class="setting checkbox">
            <input
              id="lp-adaptive"
              type="checkbox"
              checked={settings.adaptiveCompletions}
              onChange={(e) => onPatch({ adaptiveCompletions: (e.currentTarget as HTMLInputElement).checked })}
            />
            <label for="lp-adaptive">Adaptive completions</label>
          </div>
        </>
      ) : (
        <p class="muted">Loading settings…</p>
      )}

      <h2>Learning</h2>
      {stats ? (
        <>
          {stats.adaptive ? null : <p class="muted">Adaptive completions are off: learned values are not applied.</p>}
          <StatsTable stats={stats} />
          {stats.logPath ? (
            <p class="muted log-path">
              <span>Log: </span>
              <code>{stats.logPath}</code>
            </p>
          ) : null}
        </>
      ) : (
        <p class="muted">Loading stats…</p>
      )}
      <button type="button" class="secondary" onClick={onResetLearning}>
        Reset learning
      </button>
    </section>
  );
}
