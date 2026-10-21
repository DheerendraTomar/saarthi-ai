// Launches a real VS Code (downloaded once into vscode/.vscode-test/) with this
// extension in development mode against a temp workspace containing `a.py`, and
// runs the mocha suite in ./suite. The core is the scripted test/fakeCore.mjs
// (LOCALPILOT_FAKE_CORE=1), so neither the Rust core nor Ollama is needed.
// Usage: npm run test:e2e -w vscode   (VSCODE_TEST_VERSION overrides the VS Code version)
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

/** The VS Code version the smoke test pins (the one installed on the dev machine). */
const VSCODE_VERSION = process.env.VSCODE_TEST_VERSION ?? "1.142.0";

async function main(): Promise<void> {
  // Bundled to out-test/runTests.js; the extension root is one level up.
  const extensionDevelopmentPath = resolve(__dirname, "..");
  const extensionTestsPath = resolve(__dirname, "suite", "index.js");
  const workspace = mkdtempSync(join(tmpdir(), "localpilot-e2e-"));
  const userData = mkdtempSync(join(tmpdir(), "localpilot-e2e-user-"));
  writeFileSync(join(workspace, "a.py"), "def main():\n    \n");
  const downloaded = await downloadAndUnzipVSCode({
    version: VSCODE_VERSION,
    cachePath: join(extensionDevelopmentPath, ".vscode-test"),
  });
  // VS Code 1.110+ renamed the macOS executable `Contents/MacOS/Electron` to `Code`;
  // @vscode/test-electron 2.x still returns the old name (3.x fixes it but needs Node 22).
  const vscodeExecutablePath = existsSync(downloaded) ? downloaded : join(dirname(downloaded), "Code");
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, "--disable-extensions", "--skip-welcome", "--skip-release-notes", `--user-data-dir=${userData}`],
      extensionTestsEnv: { LOCALPILOT_FAKE_CORE: "1", LOCALPILOT_E2E_WORKSPACE: workspace },
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("LocalPilot e2e smoke failed:", err);
  process.exit(1);
});
