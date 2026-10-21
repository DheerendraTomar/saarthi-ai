package dev.localpilot.sync

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import dev.localpilot.actions.LocalPilotHost

/**
 * On project open (background coroutine, never the EDT): [LocalPilotHost.ensureInstalled] installs the document sync
 * and the host hooks, then starts the core. Projects that were already open when the plugin was loaded dynamically
 * never run this; they are covered by [dev.localpilot.LocalPilotDynamicPluginListener] and the lazy calls from the
 * tool window and the status bar widget.
 */
class LocalPilotStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        // Tests drive the sync with a fake sink; never spawn a real core from the light test project.
        if (ApplicationManager.getApplication().isUnitTestMode) return
        LocalPilotHost.getInstance(project).ensureInstalled()
    }
}
