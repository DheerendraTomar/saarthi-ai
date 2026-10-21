package dev.localpilot.status

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.localpilot.actions.HostStatus
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
}
