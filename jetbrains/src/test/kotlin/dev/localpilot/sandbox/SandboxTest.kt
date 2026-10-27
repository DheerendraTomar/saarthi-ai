package dev.localpilot.sandbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Path

class SandboxTest {
    private val profile = Path.of("/p/lib/sandbox/no-network.sb")

    @Test
    fun profile_sits_under_lib_sandbox() {
        assertEquals(Path.of("/p/lib/sandbox/no-network.sb"), Sandbox.profilePath(Path.of("/p")))
        assertEquals(null, Sandbox.profilePath(null))
    }

    @Test
    fun command_is_an_argv_list_never_interpolated() {
        val cmd = "echo 'a b' && rm -rf \"\$HOME\"; \$(x)"
        val plan = Sandbox.planCommand(cmd, true, profile, true) as Sandbox.CommandPlan.Run
        assertEquals(listOf("/usr/bin/sandbox-exec", "-f", profile.toString(), "/bin/sh", "-c", cmd), plan.argv)
    }

    @Test
    fun commands_fail_closed() {
        for ((mac, prof, exe) in listOf(Triple(false, profile, true), Triple(true, null, true), Triple(true, profile, false))) {
            val plan = Sandbox.planCommand("ls", mac, prof, exe)
            assertEquals(
                Sandbox.CommandPlan.Refuse("LocalPilot runs commands only inside a no-network sandbox (macOS). Not run: ls"),
                plan,
            )
        }
    }

    @Test
    fun network_note_only_on_failure() {
        assertEquals("x", Sandbox.withNetworkNote("x", 0))
        assertEquals("(LocalPilot runs commands without network access)", Sandbox.withNetworkNote("", 1))
        assertEquals("e\n(LocalPilot runs commands without network access)", Sandbox.withNetworkNote("e\n", 2))
        assertEquals("e\n(LocalPilot runs commands without network access)", Sandbox.withNetworkNote("e", 2))
    }

    @Test
    fun ollama_start_uses_the_launch_agent_when_present() {
        val plist = Path.of("/Users/o'neil/Library/LaunchAgents/local.ollama.sandboxed.plist")
        val plan = Sandbox.planOllamaStart(true, plist, true, profile, true) as Sandbox.OllamaStart.Shell
        assertTrue(plan.viaLaunchAgent)
        assertEquals(
            "launchctl bootstrap gui/$(id -u) '/Users/o'\\''neil/Library/LaunchAgents/local.ollama.sandboxed.plist' 2>/dev/null " +
                "|| launchctl kickstart gui/$(id -u)/local.ollama.sandboxed",
            plan.argv[2],
        )
        assertEquals(listOf("/bin/sh", "-c"), plan.argv.take(2))
    }

    @Test
    fun ollama_start_falls_back_to_sandbox_exec() {
        val plan = Sandbox.planOllamaStart(true, Path.of("/x.plist"), false, Path.of("/my dir/no-network.sb"), true) as Sandbox.OllamaStart.Shell
        assertEquals(false, plan.viaLaunchAgent)
        assertEquals(mapOf("OLLAMA_NO_CLOUD" to "1", "OLLAMA_HOST" to "127.0.0.1:11434"), plan.env)
        assertEquals(
            "export OLLAMA_NO_CLOUD=1 OLLAMA_HOST='127.0.0.1:11434'; exec /usr/bin/sandbox-exec -f '/my dir/no-network.sb' ollama serve",
            plan.argv[2],
        )
    }

    @Test
    fun ollama_start_refuses_off_mac_or_without_sandbox() {
        val off = Sandbox.planOllamaStart(false, Path.of("/x.plist"), true, profile, true)
        assertEquals(Sandbox.OllamaStart.Unsupported(Sandbox.UNSUPPORTED_MESSAGE), off)
        assertTrue(Sandbox.UNSUPPORTED_MESSAGE.contains("macOS") && Sandbox.UNSUPPORTED_MESSAGE.contains("OLLAMA_NO_CLOUD=1"))
        assertTrue(Sandbox.planOllamaStart(true, null, false, null, true) is Sandbox.OllamaStart.Unsupported)
        assertTrue(Sandbox.planOllamaStart(true, null, false, profile, false) is Sandbox.OllamaStart.Unsupported)
    }

    @Test
    fun pull_commands_name_the_missing_model() {
        assertEquals("ollama pull b", Sandbox.pullCommands("model b not found", listOf("a", "b")))
        assertEquals("ollama pull a\nollama pull b", Sandbox.pullCommands("some model", listOf("a", "b", "a")))
    }
}
