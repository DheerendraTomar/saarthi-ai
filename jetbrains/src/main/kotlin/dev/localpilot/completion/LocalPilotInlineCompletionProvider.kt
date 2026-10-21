package dev.localpilot.completion

import com.intellij.codeInsight.inline.completion.DebouncedInlineCompletionProvider
import com.intellij.codeInsight.inline.completion.DefaultInlineCompletionInsertHandler
import com.intellij.codeInsight.inline.completion.InlineCompletion
import com.intellij.codeInsight.inline.completion.InlineCompletionEvent
import com.intellij.codeInsight.inline.completion.InlineCompletionEventListener
import com.intellij.codeInsight.inline.completion.InlineCompletionEventType
import com.intellij.codeInsight.inline.completion.InlineCompletionHandler
import com.intellij.codeInsight.inline.completion.InlineCompletionInsertEnvironment
import com.intellij.codeInsight.inline.completion.InlineCompletionInsertHandler
import com.intellij.codeInsight.inline.completion.InlineCompletionProviderID
import com.intellij.codeInsight.inline.completion.InlineCompletionProviderPresentation
import com.intellij.codeInsight.inline.completion.InlineCompletionRequest
import com.intellij.codeInsight.inline.completion.elements.InlineCompletionElement
import com.intellij.codeInsight.inline.completion.elements.InlineCompletionGrayTextElement
import com.intellij.codeInsight.inline.completion.suggestion.InlineCompletionSingleSuggestion
import com.intellij.codeInsight.inline.completion.suggestion.InlineCompletionSuggestion
import com.intellij.openapi.application.readAction
import com.intellij.openapi.application.runReadActionBlocking
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.ex.util.EditorUtil
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import dev.localpilot.LocalPilotPluginDisposable
import dev.localpilot.rpc.CoreProcess
import dev.localpilot.rpc.CoreState
import dev.localpilot.rpc.LocalPilotCore
import dev.localpilot.settings.LocalPilotSettings
import dev.localpilot.settings.LocalPilotSettingsState
import dev.localpilot.sync.DocumentSyncListener
import dev.localpilot.sync.DocumentSyncService
import dev.localpilot.sync.NotebookCellSync
import dev.localpilot.sync.documentUri
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.util.concurrent.atomic.AtomicLong
import javax.swing.JComponent
import javax.swing.JLabel
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds

/** What the provider needs from a project (injected in tests; [LocalPilotInlineCompletionProvider.productionDeps] otherwise). */
class CompletionDeps(
    val client: CompletionClient,
    /** Plain-file sync: completions only in files it [DocumentSyncListener.isTracked] (null until the startup activity ran). */
    val sync: DocumentSyncListener?,
    /** Notebook cell sync: completions in code cells it [NotebookCellSync.locate]s. */
    val cells: NotebookCellSync?,
    val settings: () -> LocalPilotSettingsState,
)

/** Where a completion is requested: the uri the core knows and the UTF-16 position in it. */
data class CompletionTarget(val uri: String, val line: Int, val character: Int)

/**
 * Ghost-text completions from the LocalPilot core (`<inline.completion.provider>`, id `localpilot`).
 *
 * - [isEnabled]: `completionsEnabled`, the core READY, and the caret in a synced plain file or a synced notebook
 *   code cell. The core always runs with completions on; this is the client-side gate.
 * - [getDebounceDelay]: the platform's debounce, set from `completionDebounceMs`.
 * - [getSuggestionDebounced]: `completion/request { uri, position, requestId }` for the caret (a notebook cell's
 *   virtual uri and cell-relative position inside `.ipynb` notebooks); the platform cancels the coroutine when the
 *   user moves on, and [CoreProcess] then sends `completion/cancel { requestId }`.
 * - Outcomes, one per shown suggestion: Tab → [insertHandler] (and the session's `Insert` event) →
 *   `completion/accepted`; otherwise the platform's session events for the editor (`Show`, `Change`, `Hide`) feed a
 *   [SuggestionRun] whose [SuggestionRun.outcome] is sent when the session is hidden or superseded:
 *   `completion/outcome accepted | partial | typedThrough` or `completion/rejected`.
 */
class LocalPilotInlineCompletionProvider internal constructor(
    private val depsFor: (Project) -> CompletionDeps?,
) : DebouncedInlineCompletionProvider() {
    constructor() : this(::productionDeps)

    private val seq = AtomicLong()
    private val listenerLock = Any()
    private val reporter = OutcomeReporter()

    override val id: InlineCompletionProviderID = ID

    override val providerPresentation: InlineCompletionProviderPresentation = object : InlineCompletionProviderPresentation {
        override fun getTooltip(project: Project?): JComponent = JLabel(PRESENTATION_TEXT)
    }

    override val insertHandler: InlineCompletionInsertHandler = object : InlineCompletionInsertHandler {
        override fun afterInsertion(environment: InlineCompletionInsertEnvironment, elements: List<InlineCompletionElement>) {
            DefaultInlineCompletionInsertHandler.INSTANCE.afterInsertion(environment, elements)
            val requestId = environment.request?.getUserData(CORE_REQUEST_ID) ?: return
            val deps = environment.editor.project?.let(depsFor) ?: return
            reporter.accepted(requestId, deps.client::notify)
        }
    }

    override suspend fun getDebounceDelay(request: InlineCompletionRequest): Duration {
        val ms = request.editor.project?.let(depsFor)?.settings?.invoke()?.completionDebounceMs ?: DEFAULT_DEBOUNCE_MS
        return ms.coerceAtLeast(0).milliseconds
    }

    override fun isEnabled(event: InlineCompletionEvent): Boolean {
        val editor = when (event) {
            is InlineCompletionEvent.DocumentChange -> event.editor
            is InlineCompletionEvent.DirectCall -> event.editor
            else -> return false
        }
        val deps = editor.project?.let(depsFor) ?: return false
        if (!deps.settings().completionsEnabled || deps.client.state.value != CoreState.READY) return false
        return runReadActionBlocking { targetOf(deps, editor.document, editor.caretModel.offset) != null }
    }

    override suspend fun getSuggestionDebounced(request: InlineCompletionRequest): InlineCompletionSuggestion {
        val project = request.editor.project ?: return InlineCompletionSuggestion.Empty
        val deps = depsFor(project) ?: return InlineCompletionSuggestion.Empty
        if (!deps.settings().completionsEnabled) return InlineCompletionSuggestion.Empty
        val target = readAction { targetOf(deps, request.document, request.endOffset) } ?: return InlineCompletionSuggestion.Empty
        val requestId = "jb-${seq.incrementAndGet()}"
        val params = buildJsonObject {
            put("uri", target.uri)
            putJsonObject("position") {
                put("line", target.line)
                put("character", target.character)
            }
            put("requestId", requestId)
        }
        val result: JsonElement = try {
            deps.client.request(COMPLETION_REQUEST, params)
        } catch (e: CancellationException) {
            throw e // the client sent completion/cancel
        } catch (e: Exception) {
            LOG.debug("completion/request failed: ${e.message}")
            return InlineCompletionSuggestion.Empty // the core is not running, restarting, or refused
        }
        val text = firstItemText(result)
        if (text.isNullOrEmpty()) return InlineCompletionSuggestion.Empty
        request.putUserData(CORE_REQUEST_ID, requestId)
        request.putUserData(SUGGESTION_TEXT, text)
        installSessionListener(request.editor, request)
        return InlineCompletionSingleSuggestion.build {
            emit(InlineCompletionGrayTextElement(text))
        }
    }

    /** The core's uri and position for [offset] in [document], or null where completions are not offered. Call under a read action. */
    private fun targetOf(deps: CompletionDeps, document: Document, offset: Int): CompletionTarget? {
        val cells = deps.cells
        if (cells != null && cells.isNotebookDocument(document)) {
            val location = cells.locate(document, offset) ?: return null
            return CompletionTarget(location.uri, location.position.line, location.position.character)
        }
        val file = FileDocumentManager.getInstance().getFile(document) ?: return null
        if (deps.sync?.isTracked(file) != true) return null
        if (offset < 0 || offset > document.textLength) return null
        val line = document.getLineNumber(offset)
        return CompletionTarget(documentUri(file), line, offset - document.getLineStartOffset(line))
    }

    /**
     * Follows the platform's session events in [editor] once (per inline-completion handler), turning each shown
     * LocalPilot suggestion into one outcome report when its session ends.
     */
    private fun installSessionListener(editor: Editor, current: InlineCompletionRequest) {
        val handler = InlineCompletion.getHandlerOrNull(editor) ?: return
        val project = editor.project?.takeUnless { it.isDisposed } ?: return
        synchronized(listenerLock) {
            if (editor.getUserData(LISTENING_HANDLER) === handler) return
            editor.putUserData(LISTENING_HANDLER, handler)
        }
        // Gone with the editor, the project or the plugin (dynamic unload), whichever goes first. The parent is the
        // plugin; the editor and the project only hold platform-class disposables, removed when this one goes.
        val disposable = Disposer.newDisposable(LocalPilotPluginDisposable.getInstance(), "LocalPilot inline completion session listener")
        val withEditor = Disposer.newDisposable("LocalPilot session listener: editor")
        val withProject = Disposer.newDisposable("LocalPilot session listener: project")
        EditorUtil.disposeWithEditor(editor, withEditor)
        if (!Disposer.tryRegister(project, withProject)) {
            Disposer.dispose(disposable)
            Disposer.dispose(withEditor)
            synchronized(listenerLock) { editor.putUserData(LISTENING_HANDLER, null) }
            return
        }
        Disposer.register(withEditor) { Disposer.dispose(disposable) }
        Disposer.register(withProject) { Disposer.dispose(disposable) }
        Disposer.register(disposable) {
            Disposer.dispose(withEditor)
            Disposer.dispose(withProject)
            // A reloaded plugin (or a new provider instance) installs its own listener again.
            synchronized(listenerLock) { if (editor.getUserData(LISTENING_HANDLER) === handler) editor.putUserData(LISTENING_HANDLER, null) }
        }
        // The platform announced `current` before this listener existed: start from it.
        handler.addEventListener(SessionListener(editor, current), disposable)
    }

    /** Session events for one editor (delivered on the EDT; synchronized because it is seeded from the request coroutine). */
    private inner class SessionListener(private val editor: Editor, initial: InlineCompletionRequest) : InlineCompletionEventListener {
        /** The last request the platform started (any provider's). */
        private var request: InlineCompletionRequest? = initial
        private var ours = true
        private var run: SuggestionRun? = null
        /** The platform inserted the whole remaining suggestion (Tab). */
        private var inserted = false

        override fun on(event: InlineCompletionEventType): Unit = synchronized(this) {
            when (event) {
                is InlineCompletionEventType.Request -> {
                    finish()
                    request = event.request
                    ours = event.provider == LocalPilotInlineCompletionProvider::class.java
                }
                is InlineCompletionEventType.Show -> started()
                is InlineCompletionEventType.Change -> {
                    // The platform truncates the shown text in place: on typing (a DocumentChange event) and on
                    // Insert Next Word / Line. Only those two actions count as a chunk (a partial accept); other
                    // truncations (e.g. a matching lookup item) do not.
                    val chunk = event.event is InlineCompletionEvent.InsertNextWord || event.event is InlineCompletionEvent.InsertNextLine
                    run?.update(event.elements.joinToString("") { it.text }, chunk)
                }
                // Insert comes before Hide (and before the insert handler runs): it is what reports a Tab accept.
                is InlineCompletionEventType.Insert -> if (run != null) inserted = true
                is InlineCompletionEventType.Hide -> finish()
                else -> Unit
            }
        }

        private fun started() {
            if (run != null || !ours) return
            val r = request ?: return
            val requestId = r.getUserData(CORE_REQUEST_ID) ?: return
            val text = r.getUserData(SUGGESTION_TEXT) ?: return
            if (reporter.wasReported(requestId)) return
            run = SuggestionRun(requestId, text)
            inserted = false
        }

        private fun finish() {
            val current = run ?: return
            run = null
            val deps = editor.project?.takeUnless { it.isDisposed }?.let(depsFor) ?: return
            if (inserted) reporter.accepted(current.requestId, deps.client::notify) else reporter.finished(current, deps.client::notify)
        }
    }

    companion object {
        val ID = InlineCompletionProviderID("localpilot")
        const val PRESENTATION_TEXT = "LocalPilot"
        const val COMPLETION_REQUEST = CoreProcess.COMPLETION_REQUEST
        private const val DEFAULT_DEBOUNCE_MS = 120
        private val LOG = logger<LocalPilotInlineCompletionProvider>()

        /** The core request id of the suggestion served for an [InlineCompletionRequest]. */
        val CORE_REQUEST_ID: Key<String> = Key.create("localpilot.completion.requestId")
        private val SUGGESTION_TEXT: Key<String> = Key.create("localpilot.completion.text")
        private val LISTENING_HANDLER: Key<InlineCompletionHandler> = Key.create("localpilot.completion.listeningHandler")

        fun productionDeps(project: Project): CompletionDeps? {
            if (project.isDisposed) return null
            val sync = DocumentSyncService.getInstance(project)
            return CompletionDeps(
                client = CoreCompletionClient(LocalPilotCore.getInstance(project).process),
                sync = sync.listener,
                cells = sync.notebookCells,
                settings = { LocalPilotSettings.getInstance().state },
            )
        }

        /** The text of the first item of a `completion/request` result (the core serves at most one). */
        fun firstItemText(result: JsonElement): String? = try {
            (result as? JsonObject)?.get("items")?.jsonArray?.firstOrNull()?.jsonObject?.get("text")?.jsonPrimitive?.contentOrNull
        } catch (_: IllegalArgumentException) {
            null
        }
    }
}
