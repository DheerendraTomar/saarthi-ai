import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { CoreCommand } from "./rpc/coreClient";

/**
 * `localpilot.*` settings, sent as `initialize.settings` (the core ignores keys
 * it does not know and reads settings only at `initialize`). Two exceptions:
 * `completionsEnabled` is always sent as true (`coreInitSettings`; the
 * InlineProvider gates completions itself, so toggling needs no restart), and
 * `completionsEnabled` / `completionDebounceMs` are client-only, so changing just
 * those does not restart the core (`sameCoreSettings`). `logLevel` and
 * `coreBinaryPath` configure how the core process is launched.
 */
export interface Settings {
  ollamaUrl: string;
  completionModel: string;
  chatModel: string;
  completionsEnabled: boolean;
  completionDebounceMs: number;
  completionMaxTokens: number;
  chatThinking: "off" | "on";
  coreBinaryPath: string;
  allowedCommandsAlways: string[];
  completionContextTokens: number;
  chatContextTokens: number;
  logLevel: string;
  /** Let the core adapt completion length and add style examples from past outcomes (read by the core at `initialize`). */
  adaptiveCompletions: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  ollamaUrl: "http://localhost:11434",
  completionModel: "qwen2.5-coder:0.5b-base",
  chatModel: "qwen3.8:27b-mlx",
  completionsEnabled: true,
  completionDebounceMs: 120,
  completionMaxTokens: 32,
  chatThinking: "off",
  coreBinaryPath: "",
  allowedCommandsAlways: [],
  completionContextTokens: 3584,
  chatContextTokens: 24000,
  logLevel: "info",
  adaptiveCompletions: true,
});

export function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration("localpilot");
  const out = {} as Record<keyof Settings, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    out[key] = cfg.get(key, DEFAULT_SETTINGS[key]);
  }
  return out as unknown as Settings;
}

/**
 * Writes `localpilot.<key>` to the scope its effective value comes from
 * (workspace folder, workspace, else user settings), so a workspace override
 * can never turn the write into a no-op.
 */
export async function updateSetting(key: keyof Settings, value: unknown): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("localpilot");
  const where = cfg.inspect(key);
  const target =
    where?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : where?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await cfg.update(key, value, target);
}

/** Rust target triple of the bundled core for this platform, if we ship one. */
export function targetTriple(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const table: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc",
  };
  return table[`${platform}-${arch}`];
}

export interface ResolveBinaryOptions {
  /** Value of `localpilot.coreBinaryPath`; read from the configuration when omitted. */
  coreBinaryPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  exists?: (path: string) => boolean;
}

/**
 * How to launch the core, in priority order:
 * 1. `LOCALPILOT_FAKE_CORE=1` → `test/fakeCore.mjs` run by this Node/Electron
 *    runtime (`ELECTRON_RUN_AS_NODE=1`), for unit and e2e tests;
 * 2. the `localpilot.coreBinaryPath` setting;
 * 3. the bundled `bin/<triple>/localpilot-core`;
 * otherwise throws an error that says how to fix it.
 */
export function resolveBinaryPath(extensionPath: string, opts: ResolveBinaryOptions = {}): CoreCommand {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  if (env.LOCALPILOT_FAKE_CORE === "1") {
    return {
      command: process.execPath,
      args: [join(extensionPath, "test", "fakeCore.mjs")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  const override = (opts.coreBinaryPath ?? readSettings().coreBinaryPath).trim();
  if (override) {
    if (!exists(override)) {
      throw new Error(
        `LocalPilot: localpilot.coreBinaryPath points to "${override}", which does not exist. ` +
          `Fix the path or clear the setting to use the bundled core.`,
      );
    }
    return { command: override, args: [] };
  }
  const platform = opts.platform ?? process.platform;
  const triple = targetTriple(platform, opts.arch ?? process.arch);
  const exe = platform === "win32" ? "localpilot-core.exe" : "localpilot-core";
  const bundled = triple ? join(extensionPath, "bin", triple, exe) : undefined;
  if (bundled && exists(bundled)) return { command: bundled, args: [] };
  throw new Error(
    `LocalPilot: no core binary for ${platform}-${opts.arch ?? process.arch}` +
      (bundled ? ` (looked for ${bundled})` : "") +
      `. Build it with scripts/build-core.sh, or set localpilot.coreBinaryPath to a localpilot-core binary.`,
  );
}
