import { spawn } from "node:child_process";
import type * as vscode from "vscode";

/** Wire types of the core→client `workspace/runCommand` request (core/src/protocol.rs). */
export interface RunCommandParams {
  command: string;
  cwd?: string;
}

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  /** Hard limit before the command is killed (default 10 minutes). */
  timeoutMs?: number;
  /** cwd when the core sends none (the workspace root). */
  defaultCwd?: string;
}

/** Characters of each stream returned to the core (the tail; the start is dropped). */
export const OUTPUT_TAIL_BYTES = 16 * 1024;
export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const TRUNCATED = "[… output truncated; last 16 KB shown]\n";

/** Keeps the last `limit` characters of a stream. */
class Tail {
  private text = "";
  private dropped = false;
  constructor(private readonly limit: number) {}
  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > 2 * this.limit) this.trim();
  }
  private trim(): void {
    if (this.text.length > this.limit) {
      this.text = this.text.slice(this.text.length - this.limit);
      this.dropped = true;
    }
  }
  value(): string {
    this.trim();
    return this.dropped ? TRUNCATED + this.text : this.text;
  }
}

/**
 * Runs an approved `run_command` through the user's shell (the core asks only
 * after the user approved). Output is echoed to `out` and its tails returned;
 * after `timeoutMs` the whole process group is killed and `exitCode` is -1.
 * Never throws.
 */
export function runCommand(params: RunCommandParams, out: vscode.OutputChannel, opts: RunCommandOptions = {}): Promise<RunCommandResult> {
  const timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const cwd = params.cwd || opts.defaultCwd || process.cwd();
  const stdout = new Tail(OUTPUT_TAIL_BYTES);
  const stderr = new Tail(OUTPUT_TAIL_BYTES);
  const posix = process.platform !== "win32";
  out.appendLine(`$ ${params.command}    (cwd: ${cwd})`);

  return new Promise<RunCommandResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (note) {
        stderr.push((stderr.value() && !stderr.value().endsWith("\n") ? "\n" : "") + note);
        out.appendLine(`[${note}]`);
      } else {
        out.appendLine(`[exit code ${exitCode}]`);
      }
      resolve({ exitCode, stdout: stdout.value(), stderr: stderr.value() });
    };

    let child: ReturnType<typeof spawn>;
    try {
      // detached → own process group, so a timeout kills the command's children too.
      child = spawn(params.command, [], { shell: true, cwd, env: process.env, detached: posix, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      settled = true;
      const msg = e instanceof Error ? e.message : String(e);
      out.appendLine(`[failed to start: ${msg}]`);
      resolve({ exitCode: -1, stdout: "", stderr: msg });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      // If something still holds the pipes open, do not wait for them forever.
      setTimeout(() => finish(-1, `timed out after ${Math.round(timeoutMs / 1000)} s; killed`), 2000).unref();
    }, timeoutMs);

    const kill = () => {
      try {
        if (posix && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout.push(d);
      out.append(d);
    });
    child.stderr?.on("data", (d: string) => {
      stderr.push(d);
      out.append(d);
    });
    child.on("error", (e) => {
      if (child.pid === undefined) {
        stderr.push(`failed to start in ${cwd}: ${e.message}`);
        finish(-1, `failed to start: ${e.message}`);
      }
    });
    child.on("close", (code, signal) => {
      if (timedOut) finish(-1, `timed out after ${Math.round(timeoutMs / 1000)} s; killed`);
      else finish(code ?? (signal ? -1 : 0));
    });
  });
}
