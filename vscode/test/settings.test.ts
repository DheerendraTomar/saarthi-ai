import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configValues } from "./mocks/vscode";
import { DEFAULT_SETTINGS, readSettings, resolveBinaryPath } from "../src/settings";
import { lineSplitter } from "../src/rpc/coreClient";

afterEach(() => {
  for (const k of Object.keys(configValues)) delete configValues[k];
});

describe("settings", () => {
  it("read_settings_uses_defaults_and_overrides", () => {
    expect(readSettings()).toEqual(DEFAULT_SETTINGS);
    configValues["localpilot.completionModel"] = "qwen2.5-coder:1.5b-base";
    configValues["localpilot.logLevel"] = "debug";
    expect(readSettings()).toMatchObject({ completionModel: "qwen2.5-coder:1.5b-base", logLevel: "debug", chatModel: "qwen3.8:27b-mlx" });
  });

  it("resolve_binary_path_prefers_fake_then_setting_then_bundled", () => {
    const ext = "/ext";
    const bundled = join(ext, "bin", "aarch64-apple-darwin", "localpilot-core");
    const base = { platform: "darwin", arch: "arm64", env: {} };
    expect(resolveBinaryPath(ext, { ...base, env: { LOCALPILOT_FAKE_CORE: "1" }, coreBinaryPath: "/x" })).toEqual({
      command: process.execPath,
      args: [join(ext, "test", "fakeCore.mjs")],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(resolveBinaryPath(ext, { ...base, coreBinaryPath: "/opt/core", exists: () => true })).toEqual({
      command: "/opt/core",
      args: [],
    });
    expect(() => resolveBinaryPath(ext, { ...base, coreBinaryPath: "/opt/core", exists: () => false })).toThrow(
      /coreBinaryPath.*does not exist/,
    );
    expect(resolveBinaryPath(ext, { ...base, coreBinaryPath: "", exists: (p) => p === bundled })).toEqual({
      command: bundled,
      args: [],
    });
    // The setting is read from the configuration when not passed.
    configValues["localpilot.coreBinaryPath"] = "/from/config";
    expect(resolveBinaryPath(ext, { ...base, exists: () => true }).command).toBe("/from/config");
    delete configValues["localpilot.coreBinaryPath"];
    expect(() => resolveBinaryPath(ext, { ...base, exists: () => false })).toThrow(/scripts\/build-core\.sh.*coreBinaryPath/);
    expect(() => resolveBinaryPath(ext, { ...base, platform: "sunos", exists: () => true })).toThrow(/no core binary for sunos-arm64/);
  });

  it("line_splitter_joins_partial_lines_across_chunks", () => {
    const lines: string[] = [];
    const feed = lineSplitter((l) => lines.push(l));
    feed('{"a"');
    expect(lines).toEqual([]);
    feed(':1}\n{"b":2}\r\n{"c');
    feed('":"é"}\n');
    feed("\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":"é"}', ""]);
  });
});
