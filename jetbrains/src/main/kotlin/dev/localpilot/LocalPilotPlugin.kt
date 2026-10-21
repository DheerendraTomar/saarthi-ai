package dev.localpilot

import com.intellij.ide.plugins.DynamicPluginListener
import com.intellij.ide.plugins.IdeaPluginDescriptor
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.ProjectManager
import dev.localpilot.actions.LocalPilotHost

const val PLUGIN_ID = "dev.localpilot"

/**
 * "Install Plugin from Disk" loads LocalPilot without a restart (all its extension points are dynamic), and startup
 * activities do not run for projects that are already open. This installs LocalPilot into each of them
 * ([LocalPilotHost.ensureInstalled] is idempotent; the tool window and the status bar widget call it lazily too).
 */
class LocalPilotDynamicPluginListener : DynamicPluginListener {
    override fun pluginLoaded(pluginDescriptor: IdeaPluginDescriptor) {
        if (pluginDescriptor.pluginId.idString != PLUGIN_ID) return
        if (ApplicationManager.getApplication().isUnitTestMode) return
        for (project in ProjectManager.getInstance().openProjects) {
            if (LocalPilotHost.isAvailable(project)) LocalPilotHost.getInstance(project).ensureInstalledLater()
        }
    }
}

/**
 * The plugin's lifetime as a [Disposable] (an application service is disposed when the plugin is unloaded). Parent of
 * listeners attached to platform objects that may outlive a dynamic unload (e.g. an editor's inline-completion handler).
 */
@Service(Service.Level.APP)
class LocalPilotPluginDisposable : Disposable {
    override fun dispose() = Unit

    companion object {
        fun getInstance(): LocalPilotPluginDisposable = service()
    }
}
