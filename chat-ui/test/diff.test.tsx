import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { Diff, DIFF_COLLAPSE_LINES } from "../src/components/Diff";

afterEach(cleanup);

function bigDiff(n: number): string {
  const lines = ["--- a/big.txt", "+++ b/big.txt", `@@ -1,${n} +1,${n} @@`];
  for (let i = 0; lines.length < n; i++) lines.push(i % 3 === 0 ? `+added ${i}` : i % 3 === 1 ? `-removed ${i}` : ` same ${i}`);
  return lines.join("\n");
}

describe("Diff", () => {
  it("classifies_lines_as_text", () => {
    const { container } = render(<Diff diff={"--- a/x\n+++ b/x\n@@ -1 +1 @@\n ctx\n-<b>old</b>\n+new"} />);
    const lines = [...container.querySelectorAll(".diff-line")];
    expect(lines.map((l) => l.className.replace("diff-line ", ""))).toEqual(["meta", "meta", "hunk", "ctx", "del", "add"]);
    expect(container.querySelector("b")).toBeNull();
    expect(lines[4].textContent).toBe("-<b>old</b>");
  });

  it("diff_collapses_long_input_and_expands", () => {
    expect(DIFF_COLLAPSE_LINES).toBe(400);
    const { container } = render(<Diff diff={bigDiff(1000)} />);
    expect(container.querySelectorAll(".diff-line")).toHaveLength(400);
    const more = screen.getByRole("button", { name: "Show all 1000 lines" });
    fireEvent.click(more);
    expect(container.querySelectorAll(".diff-line")).toHaveLength(1000);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();

    // At or below the limit nothing is collapsed.
    cleanup();
    const small = render(<Diff diff={bigDiff(400)} />);
    expect(small.container.querySelectorAll(".diff-line")).toHaveLength(400);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("large_diff_renders_fast", () => {
    // Warm up the JIT / jsdom so the measurement reflects steady state.
    render(<Diff diff={bigDiff(500)} />);
    cleanup();

    const text = bigDiff(2000);
    const t0 = performance.now();
    const { container } = render(<Diff diff={text} />);
    const elapsed = performance.now() - t0;
    expect(container.querySelectorAll(".diff-line")).toHaveLength(400);
    expect(elapsed).toBeLessThan(100);

    // Expanding renders all 2000 lines, also within budget (Review Focus 5).
    const t1 = performance.now();
    fireEvent.click(screen.getByRole("button", { name: "Show all 2000 lines" }));
    expect(performance.now() - t1).toBeLessThan(100);
    expect(container.querySelectorAll(".diff-line")).toHaveLength(2000);
  });
});
