import { existsSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMAND_TIMEOUT_MS, OUTPUT_TAIL_BYTES, runCommand } from "../src/chat/runCommand";
import { resetMock, window, type MockOutputChannel } from "./mocks/vscode";
import type * as vscode from "vscode";

let out: MockOutputChannel;
let dir: string;
const profile = resolve(__dirname, "../../sandbox/no-network.sb");
const node = JSON.stringify(process.execPath);

beforeEach(() => {
  resetMock();
  out = window.createOutputChannel("LocalPilot");
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lp-run-")));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const channel = () => out as unknown as vscode.OutputChannel;

const live = process.platform === "darwin" ? describe : describe.skip;

live("runCommand (sandboxed)", () => {
  it("runCommand_captures_tail_and_exit_code", async () => {
    // 40 000 bytes on stdout ending in a marker, a short stderr, exit code 3, in `dir`.
    const script = [
      `process.stdout.write("a".repeat(40000) + "END-OF-STDOUT");`,
      `process.stderr.write("warn: " + process.cwd());`,
      `process.exitCode = 3;`,
    ].join("");
    const result = await runCommand({ command: `${node} -e ${JSON.stringify(script)}`, cwd: dir }, channel(), { sandboxProfile: profile });

    expect(result.exitCode).toBe(3);
    // Only the tail is kept, and it ends with the last output.
    expect(result.stdout.endsWith("a".repeat(100) + "END-OF-STDOUT")).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES + 100);
    expect(result.stdout.length).toBeGreaterThanOrEqual(OUTPUT_TAIL_BYTES);
    expect(result.stdout).toMatch(/truncated/);
    expect(result.stderr).toBe(`warn: ${dir}\n(LocalPilot runs commands without network access)\n`);

    // Echoed to the output channel: a header with the command and cwd, the output, the exit code.
    expect(out.text).toContain(`$ ${node}`);
    expect(out.text).toContain(dir);
    expect(out.text).toContain("END-OF-STDOUT");
    expect(out.text).toContain(`warn: ${dir}`);
    expect(out.text).toMatch(/exit code 3/);

    // Short output is returned whole, shell syntax works, exit 0.
    const ok = await runCommand({ command: "echo one && echo two 1>&2" }, channel(), { sandboxProfile: profile });
    expect(ok).toEqual({ exitCode: 0, stdout: "one\n", stderr: "two\n" });
  });

  it("runCommand_strips_editor_ipc_env", async () => {
    const saved = { ...process.env };
    try {
      process.env.ELECTRON_RUN_AS_NODE = "1";
      process.env.VSCODE_IPC_HOOK = "/tmp/ipc.sock";
      process.env.LP_KEEP_ME = "kept";
      const script = `const e = process.env; console.log([e.ELECTRON_RUN_AS_NODE, e.VSCODE_IPC_HOOK, e.LP_KEEP_ME].join(","))`;
      const result = await runCommand({ command: `${node} -e ${JSON.stringify(script)}` }, channel(), { sandboxProfile: profile });
      expect(result.stdout).toBe(",,kept\n");
    } finally {
      process.env = saved;
    }
  });

  it("runCommand_reports_spawn_failure_without_throwing", async () => {
    const result = await runCommand({ command: "echo hi", cwd: join(dir, "does-not-exist") }, channel(), { sandboxProfile: profile });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/does-not-exist|ENOENT/);
  });

  it("runCommand_times_out", async () => {
    // The shell runs a child that would outlive a plain `kill` of the shell.
    const started = Date.now();
    const result = await runCommand(
      { command: `echo started; ${node} -e "setTimeout(() => {}, 30000)"; echo never`, cwd: dir },
      channel(),
      { timeoutMs: 300, sandboxProfile: profile },
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.exitCode).toBe(-1);
    expect(result.stdout).toBe("started\n");
    expect(result.stderr).toMatch(/timed out/);
    expect(out.text).toMatch(/timed out/);
  });

  it("default_timeout_is_shorter_than_the_cores_client_request_timeout", () => {
    // core/src/rpc/server.rs CLIENT_REQUEST_TIMEOUT is 10 minutes: the command must be
    // killed (and its result reported) before the core gives up on the request.
    expect(COMMAND_TIMEOUT_MS).toBe(9 * 60 * 1000);
  });
});

live("sandbox", () => it("blocks_network_but_not_local_work", async () => {
  const ok = await runCommand({ command: "echo ok" }, channel(), { sandboxProfile: profile });
  expect(ok).toEqual({ exitCode: 0, stdout: "ok\n", stderr: "" });
  const net = await runCommand({ command: "curl -sS -m 5 https://example.com" }, channel(), { sandboxProfile: profile });
  expect(net.exitCode).not.toBe(0);
  expect(net.stderr).toMatch(/without network access/);
}));

describe("runCommand fail closed", () => {
  const cases: Array<[string, Parameters<typeof runCommand>[2]]> = [
    ["not macOS", { platform: "linux", sandboxProfile: profile, exists: () => true }],
    ["no sandbox-exec", { platform: "darwin", sandboxProfile: profile, exists: (p) => p !== "/usr/bin/sandbox-exec" }],
    ["profile missing", { platform: "darwin", sandboxProfile: profile, exists: (p) => p !== profile }],
    ["profile not configured", { platform: "darwin", exists: () => true }],
  ];
  for (const [name, opts] of cases) {
    it(`does_not_run_when_${name.replace(/\W+/g, "_")}`, async () => {
      const marker = join(dir, "ran");
      const result = await runCommand({ command: `touch ${marker}`, cwd: dir }, channel(), opts);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`LocalPilot runs commands only inside a no-network sandbox (macOS). Not run: touch ${marker}`);
      expect(existsSync(marker)).toBe(false);
    });
  }
});
