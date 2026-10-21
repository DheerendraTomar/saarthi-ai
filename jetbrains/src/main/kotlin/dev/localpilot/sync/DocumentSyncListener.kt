package dev.localpilot.sync

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.runReadActionBlocking
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileDocumentManagerListener
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VirtualFile
import dev.localpilot.rpc.CoreProcess
import dev.localpilot.rpc.CoreState
import dev.localpilot.rpc.LocalPilotCore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Where document notifications go: the core in production, a recorder in tests. */
interface DocumentSink {
    /** Non-blocking; safe from listeners (queued while the core is starting, dropped while it is not running). */
    fun notify(method: String, params: JsonElement)

    /** The core's lifecycle; every transition into READY re-sends `didOpen` for all tracked documents. */
    val state: StateFlow<CoreState>
}

/** [DocumentSink] over the project's [CoreProcess]. */
class CoreDocumentSink(private val process: CoreProcess) : DocumentSink {
    override fun notify(method: String, params: JsonElement) = process.notify(method, params)
    override val state: StateFlow<CoreState> get() = process.state
}

/**
 * Hook for `.ipynb` files (Task 4). [DocumentSyncListener] applies the project gating ([isProjectFile]) and then
 * hands notebook files here instead of syncing them as plain documents. Calls come on the thread of the
 * triggering platform event (EDT for editor events; [changed] inside the write action of the change);
 * [replay] comes from a background coroutine under a read action. Implementations must only call
 * [DocumentSink.notify] (non-blocking) — never a core request.
 */
interface NotebookSync {
    fun opened(file: VirtualFile, document: Document)
    fun changed(file: VirtualFile, event: DocumentEvent)
    fun saved(file: VirtualFile)
    fun closed(file: VirtualFile)

    /** The core (re)started: re-send `didOpen` for every virtual document. */
    fun replay()
}

/**
 * Mirrors the project's open editors into the core's overlay (`textDocument/didOpen|didChange|didClose|didSave`).
 *
 * - Only [isSyncableFile] files are synced (local project content, no library/scratch/in-memory files) and only
 *   while their text is at most [MAX_SYNC_CHARS]; `.ipynb` files go to [notebookSync].
 * - Each tracked document has its own version: 1 at `didOpen`, +1 for every `didChange` (kept across restarts).
 * - `didChange` carries the incremental `{range, text}` of each [DocumentEvent] (IntelliJ offsets are UTF-16 units,
 *   the core's `character` unit), or the whole text after a bulk update / whole-text replacement.
 * - On every transition of [DocumentSink.state] into READY, all tracked documents are re-opened with their current
 *   text and version (a fresh core has an empty overlay).
 *
 * Lock order is always read action → [lock]; document events arrive inside the write action of the change, so a
 * [replay] (read action) never interleaves with a change.
 */
class DocumentSyncListener(
    private val project: Project,
    private val sink: DocumentSink,
    private val scope: CoroutineScope,
    private val parent: Disposable,
) {
    private class Entry(val file: VirtualFile, val document: Document, val uri: String, val languageId: String) {
        /** 0 until first opened in the core. */
        var version = 0
        /** The core has it open (false while it is above [MAX_SYNC_CHARS]). */
        var open = false
        var bulkDirty = false
    }

    private val lock = Any()
    private val byFile = HashMap<VirtualFile, Entry>()
    private val byDocument = HashMap<Document, Entry>()
    private val notebooks = HashMap<Document, VirtualFile>()
    @Volatile private var disposed = false

    /** Set by Task 4 before [install]; null → notebooks are not synced. */
    @Volatile var notebookSync: NotebookSync? = null

    /** The version last sent for [file], or null if the core does not have it open. */
    fun versionOf(file: VirtualFile): Int? = synchronized(lock) { byFile[file]?.takeIf { it.open }?.version }

    /** True if [file] is currently open in the core as a plain document (its uri is [documentUri]). */
    fun isTracked(file: VirtualFile): Boolean = versionOf(file) != null

    fun install() {
        Disposer.register(parent) { disposed = true }
        project.messageBus.connect(parent).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun fileOpened(source: FileEditorManager, file: VirtualFile) = this@DocumentSyncListener.fileOpened(file)
                override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
                    if (!source.isFileOpen(file)) this@DocumentSyncListener.fileClosed(file)
                }
            },
        )
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(
            object : DocumentListener {
                override fun documentChanged(event: DocumentEvent) = this@DocumentSyncListener.documentChanged(event)
                override fun bulkUpdateFinished(document: Document) = this@DocumentSyncListener.bulkUpdateFinished(document)
            },
            parent,
        )
        ApplicationManager.getApplication().messageBus.connect(parent).subscribe(
            FileDocumentManagerListener.TOPIC,
            object : FileDocumentManagerListener {
                override fun beforeDocumentSaving(document: Document) = documentSaving(document)
            },
        )
        val initial = sink.state.value
        for (file in FileEditorManager.getInstance(project).openFiles) fileOpened(file)
        val job = scope.launch {
            var previous = initial
            sink.state.collect { state ->
                if (state == CoreState.READY && previous != CoreState.READY) replay()
                previous = state
            }
        }
        Disposer.register(parent) { job.cancel() }
    }

    /** A file was opened in an editor of this project (or was already open at [install]). */
    fun fileOpened(file: VirtualFile) {
        if (disposed || !isProjectFile(project, file)) return
        runReadActionBlocking {
            val document = FileDocumentManager.getInstance().getDocument(file) ?: return@runReadActionBlocking
            if (isNotebookFile(file)) {
                val nb = notebookSync ?: return@runReadActionBlocking
                val isNew = synchronized(lock) { notebooks.put(document, file) == null }
                if (isNew) nb.opened(file, document)
                return@runReadActionBlocking
            }
            synchronized(lock) {
                if (byFile.containsKey(file)) return@runReadActionBlocking
                val entry = Entry(file, document, documentUri(file), languageIdOf(file))
                byFile[file] = entry
                byDocument[document] = entry
                if (document.textLength <= MAX_SYNC_CHARS) {
                    entry.version = 1
                    entry.open = true
                    sendOpen(entry)
                } else {
                    LOG.info("LocalPilot: not syncing ${entry.uri} (${document.textLength} characters, above $MAX_SYNC_CHARS)")
                }
            }
        }
    }

    /** The last editor of [file] in this project was closed. */
    fun fileClosed(file: VirtualFile) {
        val notebook = synchronized(lock) {
            val doc = notebooks.entries.firstOrNull { it.value == file }?.key
            if (doc != null) notebooks.remove(doc)
            doc != null
        }
        if (notebook) {
            notebookSync?.closed(file)
            return
        }
        synchronized(lock) {
            val entry = byFile.remove(file) ?: return
            byDocument.remove(entry.document)
            if (entry.open) sink.notify(DID_CLOSE, buildJsonObject { put("uri", entry.uri) })
        }
    }

    private fun documentChanged(event: DocumentEvent) {
        if (disposed) return
        val document = event.document
        val notebookFile = synchronized(lock) { notebooks[document] }
        if (notebookFile != null) {
            notebookSync?.changed(notebookFile, event)
            return
        }
        synchronized(lock) {
            val entry = byDocument[document] ?: return
            if (document.isInBulkUpdate) {
                entry.bulkDirty = true
                return
            }
            val change = if (event.isWholeTextReplaced) wholeText(document) else incrementalChange(event)
            sendChange(entry, change)
        }
    }

    private fun bulkUpdateFinished(document: Document) {
        if (disposed) return
        synchronized(lock) {
            val entry = byDocument[document] ?: return
            if (!entry.bulkDirty) return
            entry.bulkDirty = false
            sendChange(entry, wholeText(document))
        }
    }

    /** Must hold [lock]. A change that crosses [MAX_SYNC_CHARS] closes or (re)opens the document instead. */
    private fun sendChange(entry: Entry, change: JsonObject) {
        val tooBig = entry.document.textLength > MAX_SYNC_CHARS
        when {
            entry.open && tooBig -> {
                entry.open = false
                LOG.info("LocalPilot: ${entry.uri} grew above $MAX_SYNC_CHARS characters; closing it in the core")
                sink.notify(DID_CLOSE, buildJsonObject { put("uri", entry.uri) })
            }
            entry.open -> {
                entry.version++
                sink.notify(DID_CHANGE, buildJsonObject {
                    put("uri", entry.uri)
                    put("version", entry.version)
                    put("contentChanges", buildJsonArray { add(change) })
                })
            }
            !tooBig -> {
                entry.version++
                entry.open = true
                sendOpen(entry)
            }
        }
    }

    private fun documentSaving(document: Document) {
        if (disposed) return
        val notebookFile = synchronized(lock) { notebooks[document] }
        if (notebookFile != null) {
            notebookSync?.saved(notebookFile)
            return
        }
        synchronized(lock) {
            val entry = byDocument[document]?.takeIf { it.open } ?: return
            sink.notify(DID_SAVE, buildJsonObject { put("uri", entry.uri) })
        }
    }

    /** Re-sends `didOpen` (current text, current version) for everything tracked. */
    fun replay() {
        if (disposed) return
        runReadActionBlocking {
            synchronized(lock) {
                for (entry in byFile.values) if (entry.open) sendOpen(entry)
            }
            if (synchronized(lock) { notebooks.isNotEmpty() }) notebookSync?.replay()
        }
    }

    /** Must hold [lock] and a read action. */
    private fun sendOpen(entry: Entry) {
        sink.notify(DID_OPEN, buildJsonObject {
            put("uri", entry.uri)
            put("languageId", entry.languageId)
            put("version", entry.version)
            put("text", entry.document.text)
        })
    }

    companion object {
        const val DID_OPEN = "textDocument/didOpen"
        const val DID_CHANGE = "textDocument/didChange"
        const val DID_CLOSE = "textDocument/didClose"
        const val DID_SAVE = "textDocument/didSave"
        private val LOG = logger<DocumentSyncListener>()

        /** `{text}` without a range: replace the whole document. */
        fun wholeText(document: Document): JsonObject = buildJsonObject { put("text", document.text) }

        /**
         * `{range, text}` of [event] in pre-change UTF-16 positions. The start is read from the changed document
         * (text before `event.offset` is untouched); the end is the start advanced over the removed `oldFragment`
         * (Document line separators are always `\n`).
         */
        fun incrementalChange(event: DocumentEvent): JsonObject {
            val document = event.document
            val startLine = document.getLineNumber(event.offset)
            val startChar = event.offset - document.getLineStartOffset(startLine)
            val old = event.oldFragment
            val newlines = old.count { it == '\n' }
            val endLine = startLine + newlines
            val endChar = if (newlines == 0) startChar + old.length else old.length - old.lastIndexOf('\n') - 1
            return buildJsonObject {
                put("range", buildJsonObject {
                    put("start", position(startLine, startChar))
                    put("end", position(endLine, endChar))
                })
                put("text", event.newFragment.toString())
            }
        }

        private fun position(line: Int, character: Int) = buildJsonObject {
            put("line", line)
            put("character", character)
        }
    }
}

/**
 * Per-project holder of the [DocumentSyncListener] wired to the project's core. Tasks 4–5 get the sync through
 * `DocumentSyncService.getInstance(project).listener`.
 */
@Service(Service.Level.PROJECT)
class DocumentSyncService(private val project: Project, private val cs: CoroutineScope) : Disposable {
    @Volatile
    var listener: DocumentSyncListener? = null
        private set

    /** Installs the sync once (idempotent); the listeners live until the project closes. */
    @Synchronized
    fun install(): DocumentSyncListener = listener ?: DocumentSyncListener(
        project,
        CoreDocumentSink(LocalPilotCore.getInstance(project).process),
        cs,
        this,
    ).also {
        listener = it
        it.install()
    }

    override fun dispose() = Unit

    companion object {
        fun getInstance(project: Project): DocumentSyncService = project.service()
    }
}
