import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OUTPUT_TAIL_BYTES, runCommand } from "../src/chat/runCommand";
import { resetMock, window, type MockOutputChannel } from "./mocks/vscode";
import type * as vscode from "vscode";

let out: MockOutputChannel;
let dir: string;
const node = JSON.stringify(process.execPath);

beforeEach(() => {
  resetMock();
  out = window.createOutputChannel("LocalPilot");
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lp-run-")));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const channel = () => out as unknown as vscode.OutputChannel;

describe("runCommand", () => {
  it("runCommand_captures_tail_and_exit_code", async () => {
    // 40 000 bytes on stdout ending in a marker, a short stderr, exit code 3, in `dir`.
    const script = [
      `process.stdout.write("a".repeat(40000) + "END-OF-STDOUT");`,
      `process.stderr.write("warn: " + process.cwd());`,
      `process.exitCode = 3;`,
    ].join("");
    const result = await runCommand({ command: `${node} -e ${JSON.stringify(script)}`, cwd: dir }, channel());

    expect(result.exitCode).toBe(3);
    // Only the tail is kept, and it ends with the last output.
    expect(result.stdout.endsWith("a".repeat(100) + "END-OF-STDOUT")).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES + 100);
    expect(result.stdout.length).toBeGreaterThanOrEqual(OUTPUT_TAIL_BYTES);
    expect(result.stdout).toMatch(/truncated/);
    expect(result.stderr).toBe(`warn: ${dir}`);

    // Echoed to the output channel: a header with the command and cwd, the output, the exit code.
    expect(out.text).toContain(`$ ${node}`);
    expect(out.text).toContain(dir);
    expect(out.text).toContain("END-OF-STDOUT");
    expect(out.text).toContain(`warn: ${dir}`);
    expect(out.text).toMatch(/exit code 3/);

    // Short output is returned whole, shell syntax works, exit 0.
    const ok = await runCommand({ command: "echo one && echo two 1>&2" }, channel());
    expect(ok).toEqual({ exitCode: 0, stdout: "one\n", stderr: "two\n" });
  });

  it("runCommand_reports_spawn_failure_without_throwing", async () => {
    const result = await runCommand({ command: "echo hi", cwd: join(dir, "does-not-exist") }, channel());
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/does-not-exist|ENOENT/);
  });

  it("runCommand_times_out", async () => {
    // The shell runs a child that would outlive a plain `kill` of the shell.
    const started = Date.now();
    const result = await runCommand(
      { command: `echo started; ${node} -e "setTimeout(() => {}, 30000)"; echo never`, cwd: dir },
      channel(),
      { timeoutMs: 300 },
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.exitCode).toBe(-1);
    expect(result.stdout).toBe("started\n");
    expect(result.stderr).toMatch(/timed out/);
    expect(out.text).toMatch(/timed out/);
  });
});
