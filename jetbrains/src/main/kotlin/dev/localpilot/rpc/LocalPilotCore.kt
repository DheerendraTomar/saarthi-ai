package dev.localpilot.rpc

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import dev.localpilot.settings.LocalPilotSettings
import dev.localpilot.settings.LocalPilotSettingsListener
import dev.localpilot.settings.coreInitSettings
import dev.localpilot.settings.resolveBinaryPath
import dev.localpilot.settings.sameCoreSettings
import dev.localpilot.sync.workspaceOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.nio.file.Files
import java.nio.file.Path

/**
 * One LocalPilot core per open project: owns the [CoreProcess] (`process`) for the project's base
 * directory, restarts it when a core-relevant setting changes, shows an error notification when it
 * crashed past the restart limit, and shuts it down when the project closes.
 *
 * Usage (Tasks 3–5): `project.service<LocalPilotCore>().process` → `start()`, `request(...)`, `notify(...)`,
 * `onNotification(...)`, `onRequest(...)`.
 */
@Service(Service.Level.PROJECT)
class LocalPilotCore(private val project: Project, private val cs: CoroutineScope) : Disposable {
    private val settings = LocalPilotSettings.getInstance()

    /** The project folder; null for a project without one → the core is never launched (start() fails, state CRASHED). */
    val workspace: Path? = workspaceOf(project)

    /** Settings-change restarts, conflated: a burst of changes (or changes during a restart) yields one more restart. */
    private val restartRequests = Channel<Unit>(Channel.CONFLATED)

    val process = CoreProcess(
        scope = cs,
        workspace = workspace,
        command = { resolveBinaryPath(settings.state, pluginRoot()).also { ensureBundledExecutable(it) } },
        initSettings = { coreInitSettings(settings.state) },
        logLevel = { settings.state.logLevel },
        log = { level, message ->
            when (level) {
                CoreLogLevel.DEBUG -> LOG.debug(message)
                CoreLogLevel.INFO -> LOG.info(message)
                CoreLogLevel.WARN -> LOG.warn(message)
                CoreLogLevel.ERROR -> {
                    LOG.warn(message)
                    notifyError(message)
                }
            }
        },
    )

    init {
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(
            LocalPilotSettings.TOPIC,
            LocalPilotSettingsListener { old, new ->
                if (!sameCoreSettings(old, new)) restartRequests.trySend(Unit)
            },
        )
        // One restart at a time, RESTART_DEBOUNCE_MS after the last change of a burst (VS Code's in-flight/again pattern).
        cs.launch {
            for (request in restartRequests) {
                delay(RESTART_DEBOUNCE_MS)
                restartRequests.tryReceive() // changes made during the debounce are covered by this restart
                if (process.state.value == CoreState.STOPPED) continue
                try {
                    process.restart()
                } catch (e: Exception) {
                    LOG.warn("LocalPilot core restart after a settings change failed: ${e.message}")
                }
            }
        }
    }

    /** The zip may lose the executable bit on the bundled binary; restore it (never touches a user-set binary). */
    private fun ensureBundledExecutable(cmd: CoreCommand) {
        val root = pluginRoot() ?: return
        val exe = Path.of(cmd.command.first())
        if (exe.startsWith(root) && Files.isRegularFile(exe) && !Files.isExecutable(exe)) exe.toFile().setExecutable(true)
    }

    private fun notifyError(message: String) {
        if (project.isDisposed) return
        NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATION_GROUP)
            .createNotification("LocalPilot", message, NotificationType.ERROR)
            .notify(project)
    }

    override fun dispose() {
        process.dispose()
    }

    companion object {
        const val NOTIFICATION_GROUP = "LocalPilot"
        private const val RESTART_DEBOUNCE_MS = 500L
        private val LOG = logger<LocalPilotCore>()

        fun getInstance(project: Project): LocalPilotCore = project.service()

        /**
         * The installed plugin's root directory (contains `lib/bin/<triple>/localpilot-core`): the parent of
         * the `lib/` folder holding this class's jar (public-API alternative to the internal `PluginManager` lookups).
         */
        fun pluginRoot(): Path? =
            PathManager.getJarPathForClass(LocalPilotCore::class.java)?.let { Path.of(it).parent?.parent }
    }
}
