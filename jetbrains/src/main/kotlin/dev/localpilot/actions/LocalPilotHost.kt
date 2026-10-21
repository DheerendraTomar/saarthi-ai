package dev.localpilot.actions

import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.execution.ui.RunContentManager
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.EDT
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.asContextElement
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.progress.runBlockingCancellable
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.SystemInfo
import dev.localpilot.chat.ApplyEdit
import dev.localpilot.chat.ChatService
import dev.localpilot.chat.HostHooks
import dev.localpilot.chat.OllamaActions
import dev.localpilot.chat.RunCommand
import dev.localpilot.rpc.CoreProcess
import dev.localpilot.rpc.CoreState
import dev.localpilot.rpc.LocalPilotCore
import dev.localpilot.settings.LocalPilotSettings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** What the status bar shows: the core's state, the last Ollama status (`ok` / `down` / `modelMissing`), a running pull. */
data class HostStatus(
    val core: CoreState = CoreState.STOPPED,
    /** The core's last `status` / `ollama/status` answer; null until one arrived. */
    val ollama: String? = null,
    val detail: String = "",
    /** Percent of a running `ollama/pull`; null when none runs (or its size is not known yet: -1). */
    val pullPercent: Int? = null,
)

/**
 * The project's host side that is not the chat view: the ONE [RunCommand] (its console tab), the chat's
 * [OllamaActions] (Start Ollama, Pull model), the Ollama status the status bar shows and the "Ollama down" /
 * "model missing" balloons. [install] wires everything into the chat bridge before the core starts.
 *
 * Threading: [status] is a thread-safe flow; core notification handlers only update it (they run on the core's
 * reader). Balloons are posted with [Notification.notify] (any thread); console/process UI goes to the EDT.
 */
@Service(Service.Level.PROJECT)
class LocalPilotHost(private val project: Project, private val cs: CoroutineScope) : Disposable {
    private val installed = AtomicBoolean(false)
    private val _status = MutableStateFlow(HostStatus())
    val status: StateFlow<HostStatus> = _status.asStateFlow()

    /** One per project: each [dev.localpilot.chat.LocalPilotConsole] opens its own Run tab. */
    val runCommand: RunCommand by lazy { RunCommand(project) }

    private val pulling = ConcurrentHashMap.newKeySet<String>()

    /** The last successful `ollama/models` answer (the pickers show it while Ollama is down). */
    @Volatile
    var lastKnownModels: List<ModelInfo>? = null
        private set
    /** The balloon for the current down / modelMissing state; expired when the state clears. */
    @Volatile
    private var statusBalloon: Notification? = null
    /** The `ollama serve` run tab started from here (EDT only). */
    private var ollamaDescriptor: RunContentDescriptor? = null

    private val process: CoreProcess get() = LocalPilotCore.getInstance(project).process

    /** The chat UI's "Start Ollama" / "Pull model" buttons. */
    val ollama: OllamaActions = object : OllamaActions {
        override fun start() = startOllama()
        override suspend fun pull(model: String) = pullModel(model)
    }

    /**
     * Idempotent. Hands the chat bridge the real edit / command / Ollama hooks (creating [ChatService], which registers
     * the core's `workspace/applyEdit` / `workspace/runCommand` handlers) and starts following the core's state and
     * `status` notifications. Call before the core starts.
     */
    fun install() {
        if (!installed.compareAndSet(false, true)) return
        ChatService.getInstance(project).installHooks(HostHooks(edits = ApplyEdit(project), commands = runCommand, ollama = ollama))
        val process = process
        Disposer.register(this, process.onNotification(STATUS) { params -> (params as? JsonObject)?.let(::onStatus) })
        cs.launch {
            process.state.collect { state ->
                _status.update { it.copy(core = state) }
                // Every (re)start: the core's initialize result is not seen here after a restart, so ask.
                if (state == CoreState.READY) launch { checkStatusQuietly() }
            }
        }
    }

    // ------------------------------------------------------------ status

    /** A `status` / `ollama/status` payload `{ ollama, detail }`. */
    fun onStatus(params: JsonObject) {
        val ollama = (params["ollama"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return
        val detail = (params["detail"] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
        val previous = _status.value.ollama
        _status.update { it.copy(ollama = ollama, detail = detail) }
        if (ollama != previous) notifyStatus(ollama, detail)
    }

    /** Asks the core to probe Ollama again (`ollama/status`); updates the status bar and the chat view. Throws when the core is down. */
    suspend fun checkStatus() {
        val result = process.requestJson(OLLAMA_STATUS, JsonObject(emptyMap())) as? JsonObject ?: return
        onStatus(result)
        ChatService.getInstance(project).bridge.setStatus(result)
    }

    private suspend fun checkStatusQuietly() {
        try {
            checkStatus()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            LOG.debug("ollama/status failed: ${e.message}")
        }
    }

    /** "Retry": restarts a stopped/crashed core, else re-probes Ollama. */
    fun retry() {
        cs.launch {
            when (process.state.value) {
                CoreState.CRASHED, CoreState.STOPPED -> restartCoreNow()
                else -> try {
                    checkStatus()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    notify("Could not reach the LocalPilot core: ${e.message}", NotificationType.ERROR)
                }
            }
        }
    }

    fun restartCore() {
        cs.launch { restartCoreNow() }
    }

    private suspend fun restartCoreNow() {
        try {
            process.restart()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // CoreProcess already logged it (and LocalPilotCore showed the error balloon).
            LOG.info("LocalPilot core restart failed: ${e.message}")
        }
    }

    private fun notifyStatus(ollama: String, detail: String) {
        statusBalloon?.expire()
        statusBalloon = null
        val n = when (ollama) {
            "down" -> group().createNotification(
                "LocalPilot: Ollama is not running",
                detail.ifBlank { "Start Ollama to get completions and chat." },
                NotificationType.WARNING,
            ).addAction(NotificationAction.createSimpleExpiring("Start Ollama") { startOllama() })
                .addAction(NotificationAction.createSimpleExpiring("Retry") { retry() })
            "modelMissing" -> group().createNotification(
                "LocalPilot: model missing",
                detail.ifBlank { "A configured model is not installed in Ollama." },
                NotificationType.WARNING,
            ).addAction(NotificationAction.createSimpleExpiring("Pull model") { PullModelAction.choose(project, null) })
                .addAction(NotificationAction.createSimpleExpiring("Retry") { retry() })
            else -> return
        }
        if (project.isDisposed) return
        statusBalloon = n
        n.notify(project)
    }

    // ------------------------------------------------------------ Start Ollama

    /**
     * Opens (or re-shows) an "Ollama" tab in the Run tool window running `ollama serve` — only ever on a user click,
     * LocalPilot never starts Ollama by itself. Returns at once (the process is spawned off the EDT); re-probes the
     * status after 3 s and 10 s so the "down" warning clears by itself.
     *
     * A Run tab, not the Terminal tool window: the terminal plugin's API to open a tab with a command is deprecated
     * (`TerminalToolWindowManager.createShellWidget`) or experimental (`TerminalToolWindowTabsManager`) in 2026.2.
     */
    fun startOllama() {
        cs.launch {
            val running = withContext(Dispatchers.EDT + ModalityState.nonModal().asContextElement()) {
                val d = ollamaDescriptor
                val handler = d?.processHandler
                if (d != null && handler != null && !handler.isProcessTerminated) {
                    RunContentManager.getInstance(project).toFrontRunContent(DefaultRunExecutor.getRunExecutorInstance(), d)
                    true
                } else {
                    false
                }
            }
            if (!running) {
                val handler = try {
                    withContext(Dispatchers.IO) { OSProcessHandler(ollamaServeCommand()) }
                } catch (e: ExecutionException) {
                    notify("Could not run `ollama serve`: ${e.message}. Install Ollama from ollama.com.", NotificationType.ERROR)
                    return@launch
                }
                withContext(Dispatchers.EDT + ModalityState.nonModal().asContextElement()) { showOllamaConsole(handler) }
            }
            for (wait in listOf(3_000L, 7_000L)) {
                delay(wait)
                checkStatusQuietly()
            }
        }
    }

    private fun showOllamaConsole(handler: ProcessHandler) {
        if (project.isDisposed) {
            handler.destroyProcess()
            return
        }
        val console = TextConsoleBuilderFactory.getInstance().createBuilder(project).console
        console.attachToProcess(handler)
        val descriptor = RunContentDescriptor(console, handler, console.component, OLLAMA_TAB)
        ollamaDescriptor = descriptor
        RunContentManager.getInstance(project).showRunContent(DefaultRunExecutor.getRunExecutorInstance(), descriptor)
        handler.startNotify()
    }

    // ------------------------------------------------------------ Pull model

    /**
     * Core `ollama/pull { model }` (`""` = the completion model) in a cancellable background task fed by
     * `ollama/pullProgress`; the status bar shows the percentage. Suspends (never blocks) until the pull ended.
     * A pull of a model that is already being pulled returns at once.
     */
    suspend fun pullModel(model: String) {
        val target = model.trim().ifEmpty { LocalPilotSettings.getInstance().state.completionModel }
        if (!pulling.add(target)) return
        try {
            val outcome = CompletableDeferred<Throwable?>()
            val task = object : Task.Backgroundable(project, "LocalPilot: pulling $target", true) {
                override fun run(indicator: ProgressIndicator) {
                    indicator.isIndeterminate = true
                    val sub = process.onNotification(PULL_PROGRESS) { raw ->
                        val p = raw as? JsonObject ?: return@onNotification
                        if ((p["model"] as? JsonPrimitive)?.content != target) return@onNotification
                        (p["status"] as? JsonPrimitive)?.content?.let { indicator.text2 = it }
                        val total = (p["total"] as? JsonPrimitive)?.longOrNull
                        val completed = (p["completed"] as? JsonPrimitive)?.longOrNull
                        if (total != null && total > 0 && completed != null) {
                            val fraction = (completed.toDouble() / total).coerceIn(0.0, 1.0)
                            indicator.isIndeterminate = false
                            indicator.fraction = fraction
                            _status.update { it.copy(pullPercent = (fraction * 100).toInt()) }
                        }
                    }
                    try {
                        runBlockingCancellable { process.requestJson(OLLAMA_PULL, buildJsonObject { put("model", target) }) }
                        outcome.complete(null)
                    } catch (e: Throwable) {
                        outcome.complete(e)
                        if (e is ProcessCanceledException || e is CancellationException) throw e
                    } finally {
                        sub.dispose()
                    }
                }

                // Also runs when the task never started (project closing): the caller must not wait forever.
                override fun onFinished() {
                    outcome.complete(CancellationException("pull of $target was cancelled"))
                }
            }
            _status.update { it.copy(pullPercent = -1) }
            withContext(Dispatchers.EDT + ModalityState.any().asContextElement()) { task.queue() }
            when (val error = outcome.await()) {
                null -> {
                    notify("$target is ready.", NotificationType.INFORMATION)
                    // Clears a "model missing" warning right away (the core's next probe could be 30 s off).
                    checkStatusQuietly()
                }
                is CancellationException, is ProcessCanceledException -> Unit
                else -> notify("Pulling $target failed: ${error.message}", NotificationType.ERROR)
            }
        } finally {
            pulling.remove(target)
            if (pulling.isEmpty()) _status.update { it.copy(pullPercent = null) }
        }
    }

    // ------------------------------------------------------------ helpers

    /** Core `ollama/models`; throws when the core or Ollama cannot be reached ([lastKnownModels] is kept). */
    suspend fun fetchModels(): List<ModelInfo> =
        Models.parse(process.requestJson(OLLAMA_MODELS, JsonObject(emptyMap()))).also { lastKnownModels = it }

    /** A raw core request for the actions (stats, reset learning). */
    suspend fun request(method: String): kotlinx.serialization.json.JsonElement = process.requestJson(method, JsonObject(emptyMap()))

    /** Runs action work in the project's scope (never on the EDT unless [block] switches). */
    fun launch(block: suspend CoroutineScope.() -> Unit) {
        cs.launch(block = block)
    }

    fun notify(message: String, type: NotificationType) {
        if (project.isDisposed) return
        group().createNotification("LocalPilot", message, type).notify(project)
    }

    private fun group() = NotificationGroupManager.getInstance().getNotificationGroup(LocalPilotCore.NOTIFICATION_GROUP)

    override fun dispose() {
        statusBalloon?.expire()
    }

    companion object {
        const val STATUS = "status"
        const val OLLAMA_STATUS = "ollama/status"
        const val OLLAMA_PULL = "ollama/pull"
        const val OLLAMA_MODELS = "ollama/models"
        const val PULL_PROGRESS = "ollama/pullProgress"
        const val OLLAMA_TAB = "Ollama"
        private val LOG = logger<LocalPilotHost>()

        fun getInstance(project: Project): LocalPilotHost = project.service()

        /** `ollama serve` through the user's shell environment (PATH from the login shell on macOS). */
        fun ollamaServeCommand(): GeneralCommandLine =
            (if (SystemInfo.isWindows) GeneralCommandLine("cmd.exe", "/d", "/s", "/c", "ollama serve") else GeneralCommandLine("/bin/sh", "-c", "exec ollama serve"))
                .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
                .withCharset(Charsets.UTF_8)

        /** Whether LocalPilot actions apply: a real, open project. */
        fun isAvailable(project: Project?): Boolean = project != null && !project.isDisposed && !project.isDefault
    }
}
