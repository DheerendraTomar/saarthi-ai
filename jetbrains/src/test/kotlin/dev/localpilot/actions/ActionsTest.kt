package dev.localpilot.actions

import com.intellij.notification.Notification
import com.intellij.notification.Notifications
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.keymap.KeymapManager
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.localpilot.settings.LocalPilotSettings
import dev.localpilot.settings.LocalPilotSettingsListener
import dev.localpilot.settings.LocalPilotSettingsState
import dev.localpilot.settings.sameCoreSettings
import dev.localpilot.status.LocalPilotStatusBarWidgetFactory
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Actions against the real application settings (restored after each test) and the plugin.xml registrations. */
class ActionsTest : BasePlatformTestCase() {
    private lateinit var original: LocalPilotSettingsState
    private val changes = mutableListOf<Pair<LocalPilotSettingsState, LocalPilotSettingsState>>()

    override fun setUp() {
        super.setUp()
        original = LocalPilotSettings.getInstance().state
        com.intellij.openapi.application.ApplicationManager.getApplication().messageBus.connect(testRootDisposable)
            .subscribe(LocalPilotSettings.TOPIC, LocalPilotSettingsListener { old, new -> synchronized(changes) { changes += old to new } })
    }

    override fun tearDown() {
        try {
            LocalPilotSettings.getInstance().loadState(original)
        } catch (e: Throwable) {
            addSuppressedException(e)
        } finally {
            super.tearDown()
        }
    }

    fun test_toggle_completions_flips_setting_and_restarts_or_not() {
        val settings = LocalPilotSettings.getInstance()
        val before = settings.state.completionsEnabled
        ToggleCompletionsAction.toggle()
        assertEquals(!before, settings.state.completionsEnabled)
        assertEquals(1, changes.size)
        // completionsEnabled is a client-side gate: LocalPilotCore restarts only when !sameCoreSettings.
        val (old, new) = changes.single()
        assertTrue(sameCoreSettings(old, new))
        assertEquals(before, old.completionsEnabled)

        ToggleCompletionsAction.setCompletionsEnabled(!before) // no change → no event
        assertEquals(1, changes.size)
        ToggleCompletionsAction.toggle()
        assertEquals(before, settings.state.completionsEnabled)
        assertEquals(2, changes.size)

        // The registered action is this ToggleAction and reads the setting.
        val action = ActionManager.getInstance().getAction("LocalPilot.ToggleCompletions")
        assertTrue(action is ToggleCompletionsAction)
    }

    fun test_select_model_action_writes_setting() {
        val settings = LocalPilotSettings.getInstance()
        assertTrue(Models.select(ModelKind.COMPLETION, "  starcoder2:3b  "))
        assertEquals("starcoder2:3b", settings.state.completionModel)
        assertTrue(Models.select(ModelKind.CHAT, "llama3.2:3b"))
        assertEquals("llama3.2:3b", settings.state.chatModel)
        assertEquals(original.chatModel, changes[1].first.chatModel)
        // A model change is core-relevant: LocalPilotCore restarts the core.
        assertTrue(changes.none { (old, new) -> sameCoreSettings(old, new) })
        // Same model or blank → nothing written.
        assertFalse(Models.select(ModelKind.CHAT, "llama3.2:3b"))
        assertFalse(Models.select(ModelKind.COMPLETION, " "))
        assertEquals(2, changes.size)
        assertEquals("llama3.2:3b", Models.current(settings.state, ModelKind.CHAT))
    }

    fun test_status_balloon_only_on_transition() {
        val shown = mutableListOf<Notification>()
        project.messageBus.connect(testRootDisposable).subscribe(Notifications.TOPIC, object : Notifications {
            override fun notify(notification: Notification) {
                if (notification.groupId == "LocalPilot") shown += notification
            }
        })
        val host = LocalPilotHost.getInstance(project)
        fun status(ollama: String) = buildJsonObject {
            put("ollama", ollama)
            put("detail", "detail for $ollama")
        }
        host.onStatus(status("down"))
        host.onStatus(status("down")) // repeated push: no second balloon
        assertEquals(1, shown.size)
        assertEquals(listOf("Start Ollama", "Retry"), shown[0].actions.map { it.templateText })
        assertEquals("down", host.status.value.ollama)
        assertEquals("detail for down", host.status.value.detail)

        host.onStatus(status("modelMissing"))
        assertEquals(2, shown.size)
        assertTrue(shown[0].isExpired)
        assertEquals(listOf("Copy pull command", "Retry"), shown[1].actions.map { it.templateText })

        host.onStatus(status("ok"))
        assertEquals(2, shown.size)
        assertTrue(shown[1].isExpired)
        host.onStatus(buildJsonObject { put("ollama", JsonPrimitive(3)) }) // malformed → ignored
        assertEquals("ok", host.status.value.ollama)
    }

    fun test_plugin_xml_registers_actions_keymap_and_widget() {
        val am = ActionManager.getInstance()
        for (id in listOf(
            "LocalPilot.OpenChat", "LocalPilot.NewSession", "LocalPilot.StartOllama", "LocalPilot.Retry",
            "LocalPilot.SelectChatModel", "LocalPilot.SelectCompletionModel", "LocalPilot.ToggleCompletions",
            "LocalPilot.ShowCompletionStats", "LocalPilot.ResetCompletionLearning", "LocalPilot.RestartCore",
        )) {
            assertNotNull(id, am.getAction(id))
        }
        assertTrue(am.getAction("LocalPilot.StatusMenu") is ActionGroup)
        val shortcuts = KeymapManager.getInstance().activeKeymap.getShortcuts("LocalPilot.OpenChat").map { it.toString() }
        assertTrue(shortcuts.toString(), shortcuts.any { it.contains("shift") && it.contains("L") })
        assertTrue(StatusBarWidgetFactory.EP_NAME.extensionList.any { it is LocalPilotStatusBarWidgetFactory })
    }
}
