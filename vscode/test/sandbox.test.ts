import { describe, expect, it } from "vitest";
import { commandPlan, ollamaStartPlan, SANDBOX_EXEC, shellQuote, sandboxProfilePath } from "../src/sandbox";

const PLIST = "/Users/me/Library/LaunchAgents/local.ollama.sandboxed.plist";

describe("shellQuote", () => {
  it("quotes_spaces_and_single_quotes", () => {
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });
});

describe("ollamaStartPlan", () => {
  const base = { platform: "darwin" as NodeJS.Platform, uid: 501, plistPath: PLIST, plistExists: false, profile: "/ext/sandbox/no-network.sb" };

  it("restarts_the_launch_agent_when_installed", () => {
    const plan = ollamaStartPlan({ ...base, plistExists: true });
    expect(plan).toEqual({
      kind: "launchd",
      command: `launchctl bootstrap gui/501 '${PLIST}' 2>/dev/null || launchctl kickstart gui/501/local.ollama.sandboxed`,
    });
  });

  it("runs_ollama_inside_sandbox_exec_otherwise", () => {
    const plan = ollamaStartPlan({ ...base, profile: "/Users/o'brien/ext dir/sandbox/no-network.sb" });
    expect(plan).toEqual({
      kind: "sandbox",
      command: `OLLAMA_NO_CLOUD=1 OLLAMA_HOST=127.0.0.1:11434 exec ${SANDBOX_EXEC} -f '/Users/o'\\''brien/ext dir/sandbox/no-network.sb' ollama serve`,
    });
  });

  it("starts_nothing_off_macos", () => {
    for (const platform of ["linux", "win32"] as const) {
      const plan = ollamaStartPlan({ ...base, platform, plistExists: true });
      expect(plan.kind).toBe("unsupported");
      expect((plan as { message: string }).message).toMatch(/no-network sandbox.*macOS.*OLLAMA_NO_CLOUD=1/);
    }
  });
});

describe("commandPlan", () => {
  const ok = { platform: "darwin" as NodeJS.Platform, command: "echo 'hi' && ls", profile: "/p/no-network.sb", profileExists: true, sandboxExecExists: true };

  it("builds_argv_without_a_shell_or_interpolation", () => {
    expect(commandPlan(ok)).toEqual({ run: true, file: "/usr/bin/sandbox-exec", args: ["-f", "/p/no-network.sb", "/bin/sh", "-c", "echo 'hi' && ls"] });
  });

  it("fails_closed", () => {
    const refused = (o: Partial<typeof ok>) => commandPlan({ ...ok, ...o });
    for (const plan of [
      refused({ platform: "linux" }),
      refused({ platform: "win32" }),
      refused({ sandboxExecExists: false }),
      refused({ profileExists: false }),
      refused({ profile: undefined }),
    ]) {
      expect(plan).toEqual({ run: false, stderr: "LocalPilot runs commands only inside a no-network sandbox (macOS). Not run: echo 'hi' && ls" });
    }
  });
});

describe("sandboxProfilePath", () => {
  it("points_into_the_extension", () => {
    expect(sandboxProfilePath("/ext")).toBe("/ext/sandbox/no-network.sb");
  });
});
