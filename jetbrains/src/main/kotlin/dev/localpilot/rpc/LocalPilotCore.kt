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
import com.intellij.openapi.project.guessProjectDir
import dev.localpilot.settings.LocalPilotSettings
import dev.localpilot.settings.LocalPilotSettingsListener
import dev.localpilot.settings.coreInitSettings
import dev.localpilot.settings.resolveBinaryPath
import dev.localpilot.settings.sameCoreSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
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

    val workspace: Path = Path.of(project.basePath ?: project.guessProjectDir()?.path ?: System.getProperty("user.home"))

    val process = CoreProcess(
        scope = cs,
        workspace = workspace,
        command = { resolveBinaryPath(settings.state, pluginRoot()) },
        initSettings = { coreInitSettings(settings.state) },
        logLevel = { settings.state.logLevel },
        log = { level, message ->
            when (level) {
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
                if (!sameCoreSettings(old, new) && process.state.value != CoreState.STOPPED) {
                    cs.launch {
                        try {
                            process.restart()
                        } catch (e: Exception) {
                            LOG.warn("LocalPilot core restart after a settings change failed: ${e.message}")
                        }
                    }
                }
            },
        )
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
