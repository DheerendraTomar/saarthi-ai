package dev.localpilot.status

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.localpilot.actions.HostStatus
import dev.localpilot.actions.LocalPilotHost
import dev.localpilot.rpc.CoreState

class StatusWidgetTest : BasePlatformTestCase() {
    fun test_status_widget_text_per_state() {
        fun text(status: HostStatus, enabled: Boolean = true) = StatusText.render(status, enabled).text
        val ready = HostStatus(core = CoreState.READY, ollama = "ok")
        assertEquals("LocalPilot", text(ready))
        assertEquals("LocalPilot: starting…", text(HostStatus(core = CoreState.STARTING)))
        assertEquals("LocalPilot: stopped", text(HostStatus()))
        assertEquals("LocalPilot: Ollama down", text(ready.copy(ollama = "down", detail = "connection refused")))
        assertTrue(StatusText.render(ready.copy(ollama = "down", detail = "connection refused"), true).tooltip.contains("connection refused"))
        assertEquals("LocalPilot: model missing", text(ready.copy(ollama = "modelMissing")))
        assertEquals("LocalPilot: crashed", text(ready.copy(core = CoreState.CRASHED, ollama = "down")))
        assertEquals("LocalPilot: completions off", text(ready, enabled = false))
        // Ollama problems outrank the paused state; a running pull outranks everything.
        assertEquals("LocalPilot: Ollama down", text(ready.copy(ollama = "down"), enabled = false))
        assertEquals("LocalPilot: pulling 42%", text(ready.copy(core = CoreState.CRASHED, pullPercent = 42)))
        assertEquals("LocalPilot: pulling…", text(ready.copy(pullPercent = -1)))
    }

    fun test_status_shows_completions_paused_during_chat() {
        fun text(status: HostStatus, enabled: Boolean = true) = StatusText.render(status, enabled).text
        val chatting = HostStatus(core = CoreState.READY, ollama = "ok", chatActive = true)
        assertEquals("LocalPilot: completions paused during chat", text(chatting))
        // Below completions off and Ollama problems (as in VS Code), above starting/stopped.
        assertEquals("LocalPilot: completions off", text(chatting, enabled = false))
        assertEquals("LocalPilot: Ollama down", text(chatting.copy(ollama = "down")))
        assertEquals("LocalPilot: completions paused during chat", text(chatting.copy(core = CoreState.STARTING)))

        // The chat bridge's onChatActiveChanged lands in the host status the widget follows.
        val host = LocalPilotHost.getInstance(project)
        host.setChatActive(true)
        assertTrue(host.status.value.chatActive)
        host.setChatActive(false)
        assertFalse(host.status.value.chatActive)
    }
}
