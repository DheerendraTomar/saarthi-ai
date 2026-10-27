package dev.localpilot.actions

import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.application.EDT
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.asContextElement
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.table.JBTable
import com.intellij.util.ui.JBUI
import dev.localpilot.chat.ChatService
import dev.localpilot.settings.LocalPilotSettings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.awt.BorderLayout
import java.awt.event.ActionEvent
import java.nio.file.Path
import javax.swing.AbstractAction
import javax.swing.Action
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.table.DefaultTableModel

/** Base for the LocalPilot actions: enabled with a (non-default) project, updated off the EDT. */
abstract class LocalPilotAction : AnAction(), DumbAware {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = LocalPilotHost.isAvailable(e.project)
    }

    final override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        if (!LocalPilotHost.isAvailable(project)) return
        perform(project)
    }

    abstract fun perform(project: Project)
}

/** The tool window id registered in plugin.xml (5b's factory). */
const val CHAT_TOOL_WINDOW_ID = "LocalPilot"

/** On the EDT, in the project's non-modal context. */
private suspend fun <T> onEdt(block: () -> T): T = withContext(Dispatchers.EDT + ModalityState.nonModal().asContextElement()) { block() }

/** Cmd/Ctrl+Shift+L: shows the chat tool window. */
class OpenChatAction : LocalPilotAction() {
    override fun perform(project: Project) {
        ToolWindowManager.getInstance(project).getToolWindow(CHAT_TOOL_WINDOW_ID)?.activate(null)
    }
}

class NewSessionAction : LocalPilotAction() {
    override fun perform(project: Project) {
        ToolWindowManager.getInstance(project).getToolWindow(CHAT_TOOL_WINDOW_ID)?.activate(null)
        LocalPilotHost.getInstance(project).launch {
            try {
                ChatService.getInstance(project).bridge.newSession()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                LocalPilotHost.getInstance(project).notify("Could not start a new chat: ${e.message}", NotificationType.ERROR)
            }
        }
    }
}

/** Opens a Run tab running `ollama serve` (never automatic). */
class StartOllamaAction : LocalPilotAction() {
    override fun perform(project: Project) = LocalPilotHost.getInstance(project).startOllama()
}

/** Re-probes Ollama (restarts a stopped core). */
class RetryAction : LocalPilotAction() {
    override fun perform(project: Project) = LocalPilotHost.getInstance(project).retry()
}

class RestartCoreAction : LocalPilotAction() {
    override fun perform(project: Project) = LocalPilotHost.getInstance(project).restartCore()
}

/** Pauses / resumes inline completions: a client-side gate (the core keeps running; no restart). */
class ToggleCompletionsAction : ToggleAction("Inline Completions"), DumbAware {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun isSelected(e: AnActionEvent): Boolean = LocalPilotSettings.getInstance().state.completionsEnabled

    override fun setSelected(e: AnActionEvent, state: Boolean) = setCompletionsEnabled(state)

    companion object {
        /** Writes `completionsEnabled` (in [dev.localpilot.settings.CLIENT_ONLY_SETTINGS]: the core is not restarted). */
        fun setCompletionsEnabled(enabled: Boolean, settings: LocalPilotSettings = LocalPilotSettings.getInstance()) {
            val state = settings.state
            if (state.completionsEnabled == enabled) return
            state.completionsEnabled = enabled
            settings.update(state)
        }

        fun toggle(settings: LocalPilotSettings = LocalPilotSettings.getInstance()) =
            setCompletionsEnabled(!settings.state.completionsEnabled, settings)
    }
}

abstract class SelectModelAction(private val kind: ModelKind) : LocalPilotAction() {
    override fun perform(project: Project) = ModelPicker.show(project, kind)
}

class SelectChatModelAction : SelectModelAction(ModelKind.CHAT)

class SelectCompletionModelAction : SelectModelAction(ModelKind.COMPLETION)

/**
 * The model picker: the installed models (core `ollama/models`) with size, family and capability hints, the current
 * one marked. When Ollama cannot be reached it offers Start Ollama / Retry above the last known list.
 */
object ModelPicker {
    private sealed interface Item {
        data class Model(val choice: ModelChoice) : Item
        data object StartOllama : Item
        data object Retry : Item
        data object Pull : Item
    }

    fun show(project: Project, kind: ModelKind) {
        val host = LocalPilotHost.getInstance(project)
        host.launch {
            var error: String? = null
            val models = try {
                host.fetchModels()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: e.toString()
                host.lastKnownModels.orEmpty()
            }
            val current = Models.current(LocalPilotSettings.getInstance().state, kind)
            val items = buildList {
                if (error != null) {
                    add(Item.StartOllama)
                    add(Item.Retry)
                }
                Models.choices(models, kind, current).forEach { add(Item.Model(it)) }
                if (error == null && models.isEmpty()) add(Item.Pull)
            }
            val title = when {
                error == null && models.isEmpty() -> "No models are installed in Ollama"
                error == null -> "${kind.label} Model (current: $current)"
                models.isNotEmpty() -> "Ollama down — last known list"
                else -> "Ollama is not reachable: start it, then retry"
            }
            onEdt {
                if (project.isDisposed) return@onEdt
                val step = object : BaseListPopupStep<Item>(title, items) {
                    override fun getTextFor(value: Item): String = when (value) {
                        is Item.Model -> value.choice.text
                        Item.StartOllama -> "Start Ollama (in a no-network sandbox)"
                        Item.Retry -> "Retry"
                        Item.Pull -> "Copy pull command"
                    }

                    override fun getIconFor(value: Item): Icon? = when (value) {
                        is Item.Model -> when {
                            value.choice.current -> AllIcons.Actions.Checked
                            value.choice.warning -> AllIcons.General.Warning
                            else -> null
                        }
                        Item.StartOllama -> AllIcons.Actions.Execute
                        Item.Retry -> AllIcons.Actions.Refresh
                        Item.Pull -> AllIcons.Actions.Copy
                    }

                    override fun onChosen(selectedValue: Item, finalChoice: Boolean): PopupStep<*>? = doFinalStep {
                        when (selectedValue) {
                            is Item.Model -> pick(project, kind, selectedValue.choice)
                            Item.StartOllama -> host.startOllama()
                            Item.Retry -> show(project, kind)
                            Item.Pull -> host.copyPullCommand()
                        }
                    }
                }
                JBPopupFactory.getInstance().createListPopup(step).showCenteredInCurrentWindow(project)
            }
        }
    }

    private fun pick(project: Project, kind: ModelKind, choice: ModelChoice) {
        if (!Models.select(kind, choice.model.name)) return
        val host = LocalPilotHost.getInstance(project)
        // An open chat view refreshes its picker (`current`).
        host.launch { runCatching { ChatService.getInstance(project).bridge.postModels() } }
        if (kind == ModelKind.COMPLETION && !choice.model.supportsInsert) {
            host.notify(
                "${choice.model.name} does not support fill-in-the-middle; inline completions will be poor. A \"-base\" coder model works best.",
                NotificationType.WARNING,
            )
        }
    }
}

/** Core `completion/stats` in a table: one row per language. */
class ShowCompletionStatsAction : LocalPilotAction() {
    override fun perform(project: Project) {
        val host = LocalPilotHost.getInstance(project)
        host.launch {
            val stats = try {
                CompletionStats.parse(host.request("completion/stats"))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                host.notify("Could not read completion stats: ${e.message}", NotificationType.ERROR)
                return@launch
            }
            onEdt { if (!project.isDisposed) CompletionStatsDialog(project, stats).show() }
        }
    }
}

class CompletionStatsDialog(private val project: Project, private val stats: CompletionStats) : DialogWrapper(project) {
    init {
        title = "LocalPilot Completion Stats — Adaptive ${if (stats.adaptive) "On" else "Off"}"
        setOKButtonText("Close")
        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout(0, JBUI.scale(8)))
        if (stats.languages.isEmpty()) {
            panel.add(JBLabel("No completion outcomes recorded yet."), BorderLayout.CENTER)
            return panel
        }
        val model = object : DefaultTableModel(rows(stats), COLUMNS) {
            override fun isCellEditable(row: Int, column: Int) = false
        }
        val table = JBTable(model)
        table.setShowGrid(false)
        panel.add(JBScrollPane(table).apply { preferredSize = JBUI.size(820, 220) }, BorderLayout.CENTER)
        stats.logPath?.let { panel.add(JBLabel("Outcome log: $it").setCopyable(true), BorderLayout.SOUTH) }
        return panel
    }

    override fun createActions(): Array<Action> = arrayOf(okAction)

    override fun createLeftSideActions(): Array<Action> {
        val path = stats.logPath ?: return emptyArray()
        return arrayOf(object : AbstractAction("Open Log") {
            override fun actionPerformed(e: ActionEvent?) {
                val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(Path.of(path))
                if (file != null) {
                    FileEditorManager.getInstance(project).openFile(file, true)
                    close(OK_EXIT_CODE)
                }
            }
        })
    }

    companion object {
        val COLUMNS = arrayOf("Language", "Served", "Accept rate", "Accepted", "Partial", "Typed through", "Rejected", "Limits", "Examples")

        fun rows(stats: CompletionStats): Array<Array<Any>> = stats.languages.map { l ->
            arrayOf<Any>(
                l.language,
                l.served,
                "${Math.round(l.acceptRate * 100)}%",
                l.accepted,
                l.partial,
                l.typedThrough,
                l.rejected,
                "${if (l.learned && stats.adaptive) "learned" else "default"}: ${l.learnedMaxLines} lines, ${l.learnedNumPredict} tokens",
                l.examples,
            )
        }.toTypedArray()
    }
}

/** Core `completion/resetLearning` after a confirmation (the outcome log is kept). */
class ResetCompletionLearningAction : LocalPilotAction() {
    override fun perform(project: Project) {
        val choice = Messages.showOkCancelDialog(
            project,
            "Reset what LocalPilot learned from your completions (lengths and style examples)? The outcome log is kept.",
            "Reset Completion Learning",
            "Reset",
            Messages.getCancelButton(),
            Messages.getWarningIcon(),
        )
        if (choice != Messages.OK) return
        val host = LocalPilotHost.getInstance(project)
        host.launch {
            try {
                host.request("completion/resetLearning")
                host.notify("Completion learning was reset.", NotificationType.INFORMATION)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                host.notify("Could not reset learning: ${e.message}", NotificationType.ERROR)
            }
        }
    }
}
