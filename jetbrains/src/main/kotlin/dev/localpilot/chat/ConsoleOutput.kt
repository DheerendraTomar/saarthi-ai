package dev.localpilot.chat

import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.ui.ConsoleView
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.execution.ui.RunContentManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer

/** Where [RunCommand] echoes the command and its output. */
interface ConsoleOutput {
    enum class Kind { SYSTEM, STDOUT, STDERR }

    fun print(text: String, kind: Kind)

    object None : ConsoleOutput {
        override fun print(text: String, kind: Kind) = Unit
    }
}

/**
 * A "LocalPilot" tab in the Run tool window (via [RunContentManager]) showing every agent command and its output,
 * like the VS Code host's output channel. Created lazily on the EDT on the first print and recreated if the user
 * closed the tab; text printed before the console exists is buffered. Keep one per project: each instance has its own tab.
 */
class LocalPilotConsole(private val project: Project) : ConsoleOutput {
    private val lock = Any()
    private var console: ConsoleView? = null
    private var creating = false
    private val pending = mutableListOf<Pair<String, ConsoleOutput.Kind>>()

    override fun print(text: String, kind: ConsoleOutput.Kind) {
        val target = synchronized(lock) {
            val current = console
            if (current == null) {
                pending += text to kind
                if (!creating) {
                    creating = true
                    ApplicationManager.getApplication().invokeLater({ create() }, ModalityState.nonModal(), project.disposed)
                }
                return
            }
            current
        }
        target.print(text, contentType(kind))
    }

    private fun create() {
        try {
            createNow()
        } catch (e: Throwable) {
            // Never leave `creating` stuck (every later print would only grow `pending`): drop the buffer, retry on the next print.
            synchronized(lock) {
                creating = false
                pending.clear()
            }
            if (e is ProcessCanceledException) throw e
            LOG.warn("could not open the LocalPilot console", e)
        }
    }

    private fun createNow() {
        val view = TextConsoleBuilderFactory.getInstance().createBuilder(project).console
        val descriptor = RunContentDescriptor(view, null, view.component, "LocalPilot")
        // Closing the tab disposes the console: the next print opens a new one.
        Disposer.register(view) { synchronized(lock) { if (console === view) console = null } }
        RunContentManager.getInstance(project).showRunContent(DefaultRunExecutor.getRunExecutorInstance(), descriptor)
        // Flushed under the lock (ConsoleView.print only queues), so later prints cannot overtake the buffered ones.
        synchronized(lock) {
            for ((text, kind) in pending) view.print(text, contentType(kind))
            pending.clear()
            console = view
            creating = false
        }
    }

    private companion object {
        private val LOG = logger<LocalPilotConsole>()
    }

    private fun contentType(kind: ConsoleOutput.Kind) = when (kind) {
        ConsoleOutput.Kind.SYSTEM -> ConsoleViewContentType.SYSTEM_OUTPUT
        ConsoleOutput.Kind.STDOUT -> ConsoleViewContentType.NORMAL_OUTPUT
        ConsoleOutput.Kind.STDERR -> ConsoleViewContentType.ERROR_OUTPUT
    }
}
