// Bundles the extension into out/extension.js (CommonJS, Node target, `vscode` external).
// Usage: node esbuild.mjs [--watch] [--production]
//
// Also builds the shared chat UI (../chat-ui → dist/index.html, one self-contained
// file) and copies it to media/chat.html, which the chat webview loads at runtime.
// Pass --skip-ui to reuse an existing media/chat.html.
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");
const skipUi = process.argv.includes("--skip-ui");

const chatUiDir = join(here, "..", "chat-ui");
const chatHtml = join(here, "media", "chat.html");
if (!skipUi) {
  execSync("npm run build", { cwd: chatUiDir, stdio: "inherit" });
  mkdirSync(dirname(chatHtml), { recursive: true });
  copyFileSync(join(chatUiDir, "dist", "index.html"), chatHtml);
} else if (!existsSync(chatHtml)) {
  throw new Error(`--skip-ui: ${chatHtml} does not exist; run a full build first`);
}

const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
