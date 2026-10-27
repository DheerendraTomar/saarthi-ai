package dev.localpilot.sandbox

import dev.localpilot.rpc.LocalPilotCore
import java.nio.file.Files
import java.nio.file.Path

/**
 * The macOS no-network sandbox (`sandbox-exec -f no-network.sb`). Ollama and every approved agent command run inside
 * it, so nothing can leave this machine. Pure functions here; the callers do the I/O.
 */
object Sandbox {
    const val SANDBOX_EXEC = "/usr/bin/sandbox-exec"
    const val PROFILE_NAME = "no-network.sb"
    const val LAUNCH_AGENT_LABEL = "local.ollama.sandboxed"
    const val OLLAMA_HOST = "127.0.0.1:11434"

    /** Appended to stderr when a sandboxed command failed. */
    const val NO_NETWORK_NOTE = "(LocalPilot runs commands without network access)"

    /** The profile next to the core: `<pluginRoot>/lib/sandbox/no-network.sb` (see jetbrains/build.gradle.kts). */
    fun profilePath(pluginRoot: Path?): Path? = pluginRoot?.resolve("lib/sandbox/$PROFILE_NAME")

    fun bundledProfile(): Path? = profilePath(LocalPilotCore.pluginRoot())

    fun available(isMac: Boolean, profile: Path?): Boolean =
        isMac && profile != null && Files.isRegularFile(profile) && Files.isExecutable(Path.of(SANDBOX_EXEC))

    /** Single-quotes [s] for `/bin/sh`. */
    fun shQuote(s: String): String = "'" + s.replace("'", "'\\''") + "'"

    /** How to run one approved command: inside the sandbox, or not at all (fail closed). */
    sealed interface CommandPlan {
        data class Run(val argv: List<String>) : CommandPlan
        data class Refuse(val stderr: String) : CommandPlan
    }

    fun planCommand(command: String, isMac: Boolean, profile: Path?, sandboxExecExists: Boolean): CommandPlan =
        if (isMac && profile != null && sandboxExecExists) {
            CommandPlan.Run(listOf(SANDBOX_EXEC, "-f", profile.toString(), "/bin/sh", "-c", command))
        } else {
            CommandPlan.Refuse("LocalPilot runs commands only inside a no-network sandbox (macOS). Not run: $command")
        }

    /** The stderr to return: a short note is added when a sandboxed command failed. */
    fun withNetworkNote(stderr: String, exitCode: Int): String =
        if (exitCode == 0) stderr else stderr + (if (stderr.isNotEmpty() && !stderr.endsWith("\n")) "\n" else "") + NO_NETWORK_NOTE

    /** What "Start Ollama" does. */
    sealed interface OllamaStart {
        /** Run [argv] (a `/bin/sh -c` line) with [env] added. */
        data class Shell(val argv: List<String>, val env: Map<String, String>, val viaLaunchAgent: Boolean) : OllamaStart
        data class Unsupported(val message: String) : OllamaStart
    }

    const val UNSUPPORTED_MESSAGE =
        "LocalPilot only starts Ollama inside a no-network sandbox, which needs macOS. " +
            "Start Ollama yourself with OLLAMA_NO_CLOUD=1."

    fun planOllamaStart(isMac: Boolean, launchAgentPlist: Path?, launchAgentExists: Boolean, profile: Path?, sandboxExecExists: Boolean): OllamaStart {
        if (!isMac) return OllamaStart.Unsupported(UNSUPPORTED_MESSAGE)
        if (launchAgentPlist != null && launchAgentExists) {
            val plist = shQuote(launchAgentPlist.toString())
            val script = "launchctl bootstrap gui/$(id -u) $plist 2>/dev/null || launchctl kickstart gui/$(id -u)/$LAUNCH_AGENT_LABEL"
            return OllamaStart.Shell(listOf("/bin/sh", "-c", script), emptyMap(), viaLaunchAgent = true)
        }
        if (profile == null || !sandboxExecExists) {
            return OllamaStart.Unsupported("LocalPilot cannot start Ollama: the no-network sandbox ($SANDBOX_EXEC or the bundled $PROFILE_NAME) is missing. Start Ollama yourself with OLLAMA_NO_CLOUD=1.")
        }
        val env = mapOf("OLLAMA_NO_CLOUD" to "1", "OLLAMA_HOST" to OLLAMA_HOST)
        val script = "export OLLAMA_NO_CLOUD=1 OLLAMA_HOST=${shQuote(OLLAMA_HOST)}; exec $SANDBOX_EXEC -f ${shQuote(profile.toString())} ollama serve"
        return OllamaStart.Shell(listOf("/bin/sh", "-c", script), env, viaLaunchAgent = false)
    }

    /** `ollama pull` lines for the models named in [detail], else for all [configured] ones. */
    fun pullCommands(detail: String, configured: List<String>): String {
        val models = configured.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        val named = models.filter { detail.contains(it) }
        return (named.ifEmpty { models }).joinToString("\n") { "ollama pull $it" }
    }
}
