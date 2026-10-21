package dev.localpilot.actions

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.localpilot.chat.ApplyEdit
import dev.localpilot.chat.ChatService
import dev.localpilot.chat.RunCommand
import dev.localpilot.sync.DocumentSyncService

/**
 * A dynamic (no-restart) install never runs the startup activity for projects that are already open, so the plugin
 * installs itself lazily ([LocalPilotHost.ensureInstalled]) from several places; it must happen exactly once.
 */
class EnsureInstalledTest : BasePlatformTestCase() {
    fun test_ensure_installed_is_idempotent_and_installs_sync_and_hooks() {
        val host = LocalPilotHost.getInstance(project)
        val attemptsBefore = host.coreStartAttempts

        val first = host.ensureInstalled()
        val listener = DocumentSyncService.getInstance(project).listener
        assertNotNull("document sync installed", listener)
        val hooks = ChatService.getInstance(project).bridge.hooks
        assertTrue("edit hook wired", hooks.edits is ApplyEdit)
        assertTrue("command hook wired", hooks.commands is RunCommand)
        assertSame(host.runCommand, hooks.commands)
        assertSame(host.ollama, hooks.ollama)

        val second = host.ensureInstalled()
        assertFalse("second call is a no-op", second)
        assertSame("one sync listener", listener, DocumentSyncService.getInstance(project).listener)
        assertSame("hooks untouched", hooks, ChatService.getInstance(project).bridge.hooks)
        assertTrue("the first call installed", first)
        assertEquals("one core start attempt", attemptsBefore + 1, host.coreStartAttempts)
        assertTrue(host.isInstalled)
    }
}
