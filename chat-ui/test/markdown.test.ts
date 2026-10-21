import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";

function dom(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("renderMarkdown", () => {
  it("markdown_escapes_html_and_renders_code_fences", () => {
    const src = [
      "Hello **world** <b>bold?</b>",
      "",
      "<script>alert(1)</script>",
      "",
      '<img src="x" onerror="alert(1)">',
      "",
      "```python",
      'print("<hi>") & done',
      "```",
      "",
      "```",
      "plain",
      "```",
    ].join("\n");
    const html = renderMarkdown(src);

    // Raw HTML is shown as text, never parsed into elements.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<b>/);
    const root = dom(html);
    expect(root.querySelector("script, img, b")).toBeNull();
    expect(root.textContent).toContain("<script>alert(1)</script>");
    expect(root.textContent).toContain("<b>bold?</b>");
    // Markdown itself still renders.
    expect(root.querySelector("strong")?.textContent).toBe("world");

    // Fenced code: language class + data-code that round-trips the source.
    const codes = root.querySelectorAll("pre > code");
    expect(codes).toHaveLength(2);
    const py = codes[0] as HTMLElement;
    expect(py.className).toBe("language-python");
    expect(py.getAttribute("data-code")).toBe('print("<hi>") & done');
    expect(py.textContent).toBe('print("<hi>") & done');
    const plain = codes[1] as HTMLElement;
    expect(plain.className).toBe("");
    expect(plain.getAttribute("data-code")).toBe("plain");
  });

  it("sanitizes_unsafe_links_and_language_names", () => {
    const html = renderMarkdown(
      '[x](javascript:alert(1)) [ok](https://example.com) ![pic](https://example.com/a.png)\n\n```py" onclick="x\ncode\n```',
    );
    const root = dom(html);
    expect(html).not.toMatch(/javascript:/i);
    const links = [...root.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com"]);
    // Images never load (no external fetches from the webview).
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("pic");
    const code = root.querySelector("pre > code") as HTMLElement;
    expect(code.getAttribute("onclick")).toBeNull();
    expect(code.className).toMatch(/^(language-[\w+-]+)?$/);
  });
});
