package dev.localpilot.settings

import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.nio.file.Path

class LocalPilotSettingsTest {
    @Test
    fun defaults_match_vscode_and_core() {
        val s = LocalPilotSettingsState()
        assertEquals("http://localhost:11434", s.ollamaUrl)
        assertEquals("qwen2.5-coder:0.5b-base", s.completionModel)
        assertEquals("qwen3.8:27b-mlx", s.chatModel)
        assertTrue(s.completionsEnabled)
        assertEquals(120, s.completionDebounceMs)
        assertEquals(32, s.completionMaxTokens)
        assertEquals("off", s.chatThinking)
        assertEquals("", s.coreBinaryPath)
        assertEquals(emptyList<String>(), s.allowedCommandsAlways)
        assertEquals(3584, s.completionContextTokens)
        assertEquals(24000, s.chatContextTokens)
        assertEquals("info", s.logLevel)
        assertTrue(s.adaptiveCompletions)
    }

    @Test
    fun core_init_settings_always_enable_completions() {
        val json = coreInitSettings(LocalPilotSettingsState(completionsEnabled = false, completionMaxTokens = 64))
        assertEquals("true", json["completionsEnabled"]!!.jsonPrimitive.content)
        assertEquals("64", json["completionMaxTokens"]!!.jsonPrimitive.content)
        assertEquals("qwen3.8:27b-mlx", json["chatModel"]!!.jsonPrimitive.content)
        assertEquals(
            setOf(
                "ollamaUrl", "completionModel", "chatModel", "completionsEnabled", "completionDebounceMs",
                "completionMaxTokens", "chatThinking", "coreBinaryPath", "allowedCommandsAlways",
                "completionContextTokens", "chatContextTokens", "logLevel", "adaptiveCompletions",
            ),
            json.keys,
        )
    }

    @Test
    fun client_only_keys_do_not_restart_the_core() {
        val a = LocalPilotSettingsState()
        assertTrue(sameCoreSettings(a, a.copy(completionsEnabled = false, completionDebounceMs = 300)))
        assertFalse(sameCoreSettings(a, a.copy(chatModel = "other")))
        assertFalse(sameCoreSettings(a, a.copy(logLevel = "debug")))
        assertFalse(sameCoreSettings(a, a.copy(coreBinaryPath = "/x")))
        assertFalse(sameCoreSettings(a, a.copy(adaptiveCompletions = false)))
        assertFalse(sameCoreSettings(a, a.copy(allowedCommandsAlways = mutableListOf("ls"))))
    }

    @Test
    fun resolve_binary_path_prefers_setting_then_bundled() {
        val root = Path.of("/plugins/localpilot")
        val bundled = root.resolve("lib/bin/aarch64-apple-darwin/localpilot-core")
        val override = LocalPilotSettingsState(coreBinaryPath = "  /opt/core  ")
        assertEquals(listOf("/opt/core"), resolveBinaryPath(override, root, "Mac OS X", "aarch64") { true }.command)
        assertEquals(listOf(bundled.toString()), resolveBinaryPath(LocalPilotSettingsState(), root, "Mac OS X", "aarch64") { it == bundled }.command)
        assertEquals(
            listOf(root.resolve("lib/bin/x86_64-unknown-linux-gnu/localpilot-core").toString()),
            resolveBinaryPath(LocalPilotSettingsState(), root, "Linux", "amd64") { true }.command,
        )
        for ((settings, exists) in listOf(override to false, LocalPilotSettingsState() to false)) {
            try {
                resolveBinaryPath(settings, root, "Mac OS X", "aarch64") { exists }
                fail("expected CoreBinaryNotFound")
            } catch (e: CoreBinaryNotFound) {
                assertTrue(e.message!!, e.message!!.contains("coreBinaryPath") || e.message!!.contains("Core binary"))
            }
        }
    }
}
