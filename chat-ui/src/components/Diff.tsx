import { memo } from "preact/compat";
import { useMemo, useState } from "preact/hooks";

/** Diffs longer than this render collapsed, with a "show all" button. */
export const DIFF_COLLAPSE_LINES = 400;

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "ctx";

export interface DiffProps {
  /** A unified diff as produced by the core (`---`/`+++`/`@@`/`+`/`-`/` ` lines). */
  diff: string;
}

function kindOf(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/**
 * Renders a unified diff line by line as text nodes (never HTML). Long diffs
 * show only the first DIFF_COLLAPSE_LINES lines until expanded, so a large
 * preview can't freeze the webview.
 */
function DiffView({ diff }: DiffProps) {
  const lines = useMemo(() => {
    const all = diff.replace(/\n$/, "").split("\n");
    return all.map((text) => ({ text, kind: kindOf(text) }));
  }, [diff]);
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded && lines.length > DIFF_COLLAPSE_LINES;
  const shown = collapsed ? lines.slice(0, DIFF_COLLAPSE_LINES) : lines;

  return (
    <div class="diff">
      <pre class="diff-body" aria-label="Diff">
        {shown.map((l, i) => (
          <div key={i} class={`diff-line ${l.kind}`}>
            {l.text}
          </div>
        ))}
      </pre>
      {collapsed ? (
        <button type="button" class="diff-more" onClick={() => setExpanded(true)}>
          Show all {lines.length} lines
        </button>
      ) : null}
    </div>
  );
}

/** Memoized: a diff string never changes for a given card. */
export const Diff = memo(DiffView);
