/// <reference types="vitest" />
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds ONE self-contained dist/index.html (inline JS + CSS, no external
// URLs) so VS Code webviews, JetBrains JCEF and JupyterLab can embed it under
// a strict CSP.
export default defineConfig({
  plugins: [preact(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
