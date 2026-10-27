package dev.localpilot.status

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopup
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import dev.localpilot.actions.HostStatus
import dev.localpilot.actions.LocalPilotHost
import dev.localpilot.rpc.CoreState
import dev.localpilot.settings.LocalPilotSettings
import dev.localpilot.settings.LocalPilotSettingsListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import javax.swing.Icon

/** What the widget shows for a state (pure, unit-tested). */
data class StatusPresentation(val text: String, val tooltip: String, val icon: Icon?)

object StatusText {
    /**
     * Most important first (as VS Code's status bar): a crashed / stopped core, Ollama down, model
     * missing, completions off, completions paused during a chat reply, stopped, starting, otherwise ready.
     */
    fun render(status: HostStatus, completionsEnabled: Boolean): StatusPresentation {
        return when {
            status.core == CoreState.CRASHED -> StatusPresentation(
                "LocalPilot: crashed",
                "The LocalPilot core is not running. Click → Restart Core (see <project>/.localpilot/core.log).",
                AllIcons.General.Error,
            )
            status.ollama == "down" -> StatusPresentation(
                "LocalPilot: Ollama down",
                "LocalPilot: ${status.detail.ifBlank { "Ollama is not running" }}. Click → Start Ollama or Retry.",
                AllIcons.General.Warning,
            )
            status.ollama == "modelMissing" -> StatusPresentation(
                "LocalPilot: model missing",
                "LocalPilot: ${status.detail.ifBlank { "a configured model is not installed" }}. Run `ollama pull <model>` in a terminal.",
                AllIcons.General.Warning,
            )
            !completionsEnabled -> StatusPresentation(
                "LocalPilot: completions off",
                "LocalPilot inline completions are paused. Click → Inline Completions to resume.",
                AllIcons.Actions.Pause,
            )
            status.chatActive -> StatusPresentation(
                "LocalPilot: completions paused during chat",
                "LocalPilot: inline completions resume when the chat reply finishes (chat and completions share the model server).",
                AllIcons.Actions.Pause,
            )
            status.core == CoreState.STOPPED -> StatusPresentation("LocalPilot: stopped", "The LocalPilot core is not running.", null)
            status.core == CoreState.STARTING -> StatusPresentation("LocalPilot: starting…", "The LocalPilot core is starting.", null)
            else -> StatusPresentation("LocalPilot", "LocalPilot: running locally via Ollama.", null)
        }
    }
}

class LocalPilotStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = LocalPilotStatusBarWidget.ID

    override fun getDisplayName(): String = "LocalPilot"

    override fun isAvailable(project: Project): Boolean = LocalPilotHost.isAvailable(project)

    override fun createWidget(project: Project, scope: CoroutineScope): StatusBarWidget {
        // Created for every open project when the plugin is loaded dynamically (no startup activity runs then).
        if (!ApplicationManager.getApplication().isUnitTestMode) LocalPilotHost.getInstance(project).ensureInstalledLater()
        return LocalPilotStatusBarWidget(project, scope)
    }

    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}

/** Text widget: the LocalPilot state; a click opens the LocalPilot action group (`LocalPilot.StatusMenu`). */
class LocalPilotStatusBarWidget(private val project: Project, private val scope: CoroutineScope) :
    StatusBarWidget, StatusBarWidget.MultipleTextValuesPresentation {

    private var statusBar: StatusBar? = null

    @Volatile
    private var presentation = StatusText.render(HostStatus(), LocalPilotSettings.getInstance().state.completionsEnabled)

    override fun ID(): String = ID

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        val enabled = MutableStateFlow(LocalPilotSettings.getInstance().state.completionsEnabled)
        // Settings listeners may fire off the EDT; the flow only records the value.
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(
            LocalPilotSettings.TOPIC,
            LocalPilotSettingsListener { _, new -> enabled.value = new.completionsEnabled },
        )
        scope.launch(Dispatchers.EDT) {
            LocalPilotHost.getInstance(project).status.combine(enabled) { s, e -> StatusText.render(s, e) }
                .distinctUntilChanged()
                .collect {
                    presentation = it
                    statusBar.updateWidget(ID)
                }
        }
    }

    override fun getSelectedValue(): String = presentation.text

    override fun getIcon(): Icon? = presentation.icon

    override fun getTooltipText(): String = presentation.tooltip

    override fun getPopup(): JBPopup? {
        if (project.isDisposed) return null
        val group = ActionManager.getInstance().getAction(MENU_GROUP) as? ActionGroup ?: return null
        return JBPopupFactory.getInstance().createActionGroupPopup(
            "LocalPilot",
            group,
            SimpleDataContext.getProjectContext(project),
            JBPopupFactory.ActionSelectionAid.SPEEDSEARCH,
            false,
        )
    }

    // [scope] is the platform's widget scope: cancelled when the widget goes away.
    override fun dispose() {
        statusBar = null
    }

    companion object {
        const val ID = "dev.localpilot.status"
        const val MENU_GROUP = "LocalPilot.StatusMenu"
    }
}
