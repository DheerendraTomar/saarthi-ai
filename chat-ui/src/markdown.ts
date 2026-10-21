// Markdown → HTML for assistant messages. Safe to inject: raw HTML in the
// source is escaped (shown as text), link targets are restricted to
// http(s)/mailto, and images are rendered as their alt text so the webview
// never fetches anything. Fenced code gets `class="language-<lang>"` and a
// `data-code` attribute holding the raw code, inside a `.code-block` with
// Copy / Insert buttons (`data-action="copy" | "insert"`; the host page
// handles clicks by delegation).
import { Marked } from "marked";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const SAFE_HREF = /^(https?:|mailto:)/i;

const md = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    code({ text, lang }) {
      // Only the first word of the info string, and only safe characters.
      const name = (lang ?? "").trim().split(/\s+/)[0];
      const cls = /^[\w+-]+$/.test(name) ? ` class="language-${name}"` : "";
      const code = text.replace(/\n$/, "");
      return (
        `<div class="code-block"><div class="code-actions">` +
        `<button type="button" data-action="copy" aria-label="Copy code">Copy</button>` +
        `<button type="button" data-action="insert" aria-label="Insert code at cursor">Insert</button>` +
        `</div><pre><code${cls} data-code="${escapeHtml(code)}">${escapeHtml(code)}</code></pre></div>\n`
      );
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!SAFE_HREF.test(href.trim())) return inner;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(href)}"${t}>${inner}</a>`;
    },
    image({ text }) {
      return escapeHtml(text);
    },
  },
});

export function renderMarkdown(src: string): string {
  return md.parse(src, { async: false });
}
