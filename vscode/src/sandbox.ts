import { join } from "node:path";

/** The no-network profile shipped in the extension (copied from sandbox/ by scripts/package-vscode.sh). */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const OLLAMA_AGENT_LABEL = "local.ollama.sandboxed";

export const sandboxProfilePath = (extensionPath: string): string => join(extensionPath, "sandbox", "no-network.sb");

/** Single-quotes a string for /bin/sh. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export type OllamaStartPlan =
  | { kind: "launchd"; command: string }
  | { kind: "sandbox"; command: string }
  | { kind: "unsupported"; message: string };

export interface OllamaStartInput {
  platform: NodeJS.Platform;
  uid: number;
  /** ~/Library/LaunchAgents/local.ollama.sandboxed.plist */
  plistPath: string;
  plistExists: boolean;
  profile: string;
}

export const UNSUPPORTED_OLLAMA_MESSAGE =
  "LocalPilot only starts Ollama inside a no-network sandbox, which needs macOS. Start Ollama yourself with OLLAMA_NO_CLOUD=1 (OLLAMA_NO_CLOUD=1 ollama serve).";

/** What "Start Ollama" runs; never plain `ollama serve`. */
export function ollamaStartPlan(i: OllamaStartInput): OllamaStartPlan {
  if (i.platform !== "darwin") return { kind: "unsupported", message: UNSUPPORTED_OLLAMA_MESSAGE };
  if (i.plistExists) {
    const domain = `gui/${i.uid}`;
    const plist = shellQuote(i.plistPath);
    return {
      kind: "launchd",
      command: `launchctl bootstrap ${domain} ${plist} 2>/dev/null || launchctl kickstart ${domain}/${OLLAMA_AGENT_LABEL}`,
    };
  }
  return {
    kind: "sandbox",
    command: `OLLAMA_NO_CLOUD=1 OLLAMA_HOST=127.0.0.1:11434 exec ${SANDBOX_EXEC} -f ${shellQuote(i.profile)} ollama serve`,
  };
}

export type CommandPlan =
  | { run: true; file: string; args: string[] }
  | { run: false; stderr: string };

export interface CommandPlanInput {
  platform: NodeJS.Platform;
  command: string;
  /** Undefined or missing on disk → not run. */
  profile: string | undefined;
  profileExists: boolean;
  sandboxExecExists: boolean;
}

export const NO_SANDBOX_NOTE = "(LocalPilot runs commands without network access)";

/** How to run an approved command: only inside the sandbox, otherwise not at all. */
export function commandPlan(i: CommandPlanInput): CommandPlan {
  if (i.platform !== "darwin" || !i.sandboxExecExists || !i.profile || !i.profileExists) {
    return { run: false, stderr: `LocalPilot runs commands only inside a no-network sandbox (macOS). Not run: ${i.command}` };
  }
  return { run: true, file: SANDBOX_EXEC, args: ["-f", i.profile, "/bin/sh", "-c", i.command] };
}
