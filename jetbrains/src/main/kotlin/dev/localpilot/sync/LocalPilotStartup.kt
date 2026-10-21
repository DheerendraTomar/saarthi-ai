package dev.localpilot.sync

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import dev.localpilot.rpc.LocalPilotCore
import kotlinx.coroutines.CancellationException

/**
 * On project open (background coroutine, never the EDT): installs the document sync, then starts the core.
 * The sync goes first so no edit is missed; its `didOpen`s are re-sent when the core becomes READY.
 * A core that cannot start is logged (and shown as an error balloon by [LocalPilotCore]), never thrown.
 */
class LocalPilotStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        // Tests drive the sync with a fake sink; never spawn a real core from the light test project.
        if (ApplicationManager.getApplication().isUnitTestMode) return
        DocumentSyncService.getInstance(project).install()
        try {
            LocalPilotCore.getInstance(project).process.start()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            LOG.info("LocalPilot core did not start: ${e.message}")
        }
    }

    private companion object {
        private val LOG = logger<LocalPilotStartup>()
    }
}
