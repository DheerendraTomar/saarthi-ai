package dev.localpilot.sync

import com.intellij.openapi.application.readAction
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.vfs.VirtualFile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Quiet period before a notebook's concatenated `.cells.<ext>` document is re-sent (as VS Code/JupyterLab). */
const val CONCAT_DEBOUNCE_MS = 200L

/** Where a caret in a notebook lands for the core: the code cell's virtual [uri] and the cell-relative [position]. */
data class CellLocation(val uri: String, val position: Position, val cell: Cell, val file: VirtualFile)

/** The notebook cell behind a virtual cell uri: edit `document` in `[cell.startOffset, cell.endOffset)`. */
data class CellTarget(val file: VirtualFile, val document: Document, val cell: Cell)

/**
 * [NotebookSync] for PyCharm's notebook editor: each code cell of an open `.ipynb` is a virtual document
 * `<nb uri>.cell<i>.<ext>` and all code cells together are `<nb uri>.cells.<ext>` (see [NotebookCells]), the same
 * scheme as the VS Code and JupyterLab clients.
 *
 * - `opened` → `didOpen` (version 1) for every code cell, then the concat doc. `languageId` = the kernel language.
 * - `changed`: the Document is re-parsed. An edit inside one cell's content that leaves the cell structure as it was
 *   → incremental `didChange` with cell-relative positions. Anything else (cells added, removed, merged, split,
 *   kind changed) → reconcile: cells before and after the edited region keep their identity (shifted by the edit),
 *   cells in it are matched by position; every doc whose cell is gone or now has another index is closed first,
 *   then cells keeping their uri get a whole-text `didChange` if their text changed and the others a `didOpen`
 *   (version 1: a new uri is a new document). Markdown/raw cells are never synced.
 * - The concat doc is re-sent whole 200 ms after the last change (opened/closed at once when the notebook gains its
 *   first / loses its last code cell).
 * - `saved` → `didSave` for every doc; `closed` → `didClose` for every doc; `replay` → `didOpen` everything with the
 *   current text and versions.
 * - Docs above [MAX_SYNC_CHARS] are not opened (closed when they grow past it, reopened when they shrink).
 *
 * Thread safety: all state is under [lock]. Platform calls come under a read or write action ([changed] inside the
 * write action of the edit), so lock order is always read/write action → [lock]. Only [DocumentSink.notify] is called,
 * and never together with a cancellable call: [replay] and the debounced concat send run in (restartable) read
 * actions, so they build every message first and then notify in one go with no `checkCanceled` in between — a
 * restart can only happen before anything was sent.
 */
class NotebookCellSync(
    private val sink: DocumentSink,
    private val scope: CoroutineScope,
    /** Quiet time before the concat doc is re-sent (tests widen it so their "quick edits" never straddle it). */
    private val concatDebounceMs: Long = CONCAT_DEBOUNCE_MS,
) : NotebookSync {
    private class Doc(val uri: String) {
        var version = 1
        var open = false
    }

    private class State(val file: VirtualFile, val document: Document, val notebookUri: String, val languageId: String) {
        val ext = NotebookCells.extForLanguage(languageId)
        var cells: List<Cell> = emptyList()
        /** Code cell index → its virtual document. */
        val docs = HashMap<Int, Doc>()
        var concat: Doc? = null
        var concatJob: Job? = null
        var concatGeneration = 0
    }

    private val lock = Any()
    private val byFile = HashMap<VirtualFile, State>()
    private val byDocument = HashMap<Document, State>()

    override fun opened(file: VirtualFile, document: Document) {
        val language = NotebookCells.kernelLanguage(file)
        synchronized(lock) {
            byFile.remove(file)?.let { forget(it, sendClose = true) }
            val st = State(file, document, documentUri(file), language)
            st.cells = NotebookCells.parse(document.immutableCharSequence, language)
            byFile[file] = st
            byDocument[document] = st
            for (cell in NotebookCells.codeCells(st.cells)) {
                val doc = Doc(NotebookCells.cellUri(st.notebookUri, cell.index, st.ext))
                st.docs[cell.index] = doc
                openDoc(st, doc, cell.text)
            }
            syncConcatPresence(st, changed = false)
        }
    }

    override fun changed(file: VirtualFile, event: DocumentEvent) {
        synchronized(lock) {
            val st = byFile[file] ?: return
            val old = st.cells
            val new = NotebookCells.parse(event.document.immutableCharSequence, st.languageId)
            st.cells = new
            val o = event.offset
            val oldEnd = o + event.oldLength
            val newEnd = o + event.newLength

            val prefix = minOf(old.takeWhile { it.endOffset < o }.size, new.takeWhile { it.endOffset < o }.size)
            val suffix = minOf(
                old.takeLastWhile { it.markerOffset >= oldEnd }.size,
                new.takeLastWhile { it.markerOffset >= newEnd }.size,
                old.size - prefix,
                new.size - prefix,
            )
            val oldMid = old.size - prefix - suffix
            val newMid = new.size - prefix - suffix

            // Fast path: the edit is inside one cell's content and the structure is unchanged.
            if (old.size == new.size && oldMid == 1 && newMid == 1) {
                val before = old[prefix]
                val after = new[prefix]
                if (before.kind == after.kind && o >= before.startOffset && oldEnd <= before.endOffset &&
                    o >= after.startOffset && newEnd <= after.endOffset
                ) {
                    if (after.kind == CellKind.CODE) {
                        val doc = st.docs[after.index]
                        if (doc != null) incrementalChange(st, doc, before, after, event)
                        scheduleConcat(st)
                    }
                    return
                }
            }

            // Identity: new index → the old cell it continues (null = a new cell).
            val previous = arrayOfNulls<Cell>(new.size)
            for (i in 0 until prefix) previous[i] = old[i]
            for (k in 1..suffix) previous[new.size - k] = old[old.size - k]
            for (j in 0 until minOf(oldMid, newMid)) previous[prefix + j] = old[prefix + j]

            val keep = HashSet<Int>()
            for ((i, cell) in new.withIndex()) {
                val was = previous[i] ?: continue
                if (cell.kind == CellKind.CODE && was.kind == CellKind.CODE && was.index == i) keep += i
            }
            var changed = false
            // Close first: a moved cell may take over another doc's uri.
            for (index in st.docs.keys.sorted()) {
                if (index in keep) continue
                closeDoc(st.docs.remove(index)!!)
                changed = true
            }
            for (cell in NotebookCells.codeCells(new)) {
                val doc = st.docs[cell.index]
                if (doc != null) {
                    if (previous[cell.index]?.text != cell.text) {
                        doc.version++
                        changeDoc(st, doc, cell.text)
                        changed = true
                    }
                } else {
                    val fresh = Doc(NotebookCells.cellUri(st.notebookUri, cell.index, st.ext))
                    st.docs[cell.index] = fresh
                    openDoc(st, fresh, cell.text)
                    changed = true
                }
            }
            syncConcatPresence(st, changed)
        }
    }

    override fun saved(file: VirtualFile) {
        synchronized(lock) {
            val st = byFile[file] ?: return
            for (index in st.docs.keys.sorted()) saveDoc(st.docs.getValue(index))
            st.concat?.let { saveDoc(it) }
        }
    }

    override fun closed(file: VirtualFile) {
        synchronized(lock) { byFile[file]?.let { forget(it, sendClose = true) } }
    }

    override fun replay() {
        val messages = ArrayList<Pair<String, JsonObject>>()
        synchronized(lock) {
            for (st in byFile.values) {
                val code = NotebookCells.codeCells(st.cells).associateBy { it.index }
                for (index in st.docs.keys.sorted()) {
                    val doc = st.docs.getValue(index)
                    if (doc.open) messages += DocumentSyncListener.DID_OPEN to openParams(st, doc, code[index]?.text ?: "")
                }
                st.concat?.takeIf { it.open }?.let { messages += DocumentSyncListener.DID_OPEN to openParams(st, it, NotebookCells.concatText(st.cells)) }
            }
            // No cancellable call from here on (see the class comment).
            for ((method, params) in messages) sink.notify(method, params)
        }
    }

    /** True if [document] is the Document of a notebook this sync has open. */
    fun isNotebookDocument(document: Document): Boolean = synchronized(lock) { byDocument.containsKey(document) }

    /**
     * Review Focus 1: the code cell under [offset] in a synced notebook [document] → its virtual uri and the position
     * relative to the cell's start. Null for markdown/raw cells, marker lines, docs the core does not have open
     * (oversized), and documents that are not synced notebooks. Call under a read action, after the edit's events
     * (the cell list is updated synchronously in [changed]).
     */
    fun locate(document: Document, offset: Int): CellLocation? = synchronized(lock) {
        val st = byDocument[document] ?: return null
        val (cell, position) = NotebookCells.caretToCell(st.cells, offset) ?: return null
        val doc = st.docs[cell.index]?.takeIf { it.open } ?: return null
        CellLocation(doc.uri, position, cell, st.file)
    }

    fun locate(editor: Editor, offset: Int = editor.caretModel.offset): CellLocation? = locate(editor.document, offset)

    /**
     * The open code cell the core knows as [uri] (`<nb uri>.cell<i>.<ext>`); null for anything else, including the
     * `.cells.<ext>` concat doc (Task 5: `workspace/applyEdit` on a virtual cell uri edits that cell's range).
     */
    fun cellForUri(uri: String): CellTarget? = synchronized(lock) {
        for (st in byFile.values) {
            for ((index, doc) in st.docs) {
                if (doc.uri != uri) continue
                val cell = st.cells.getOrNull(index)?.takeIf { it.kind == CellKind.CODE } ?: return null
                return CellTarget(st.file, st.document, cell)
            }
        }
        null
    }

    // ---------------------------------------------------------------- internals (all under [lock])

    private fun forget(st: State, sendClose: Boolean) {
        st.concatJob?.cancel()
        st.concatJob = null
        st.concatGeneration++
        if (sendClose) {
            for (index in st.docs.keys.sorted()) closeDoc(st.docs.getValue(index))
            st.concat?.let { closeDoc(it) }
        }
        st.docs.clear()
        st.concat = null
        byFile.remove(st.file)
        byDocument.remove(st.document)
    }

    /** Opens the concat doc when the notebook has code cells and it is not open, closes it when it has none. */
    private fun syncConcatPresence(st: State, changed: Boolean) {
        val hasCode = st.cells.any { it.kind == CellKind.CODE }
        val concat = st.concat
        when {
            hasCode && concat == null -> {
                val doc = Doc(NotebookCells.concatUri(st.notebookUri, st.ext))
                st.concat = doc
                openDoc(st, doc, NotebookCells.concatText(st.cells))
            }
            !hasCode && concat != null -> {
                st.concatJob?.cancel()
                st.concatJob = null
                st.concatGeneration++
                closeDoc(concat)
                st.concat = null
            }
            changed -> scheduleConcat(st)
        }
    }

    private fun scheduleConcat(st: State) {
        if (st.concat == null) return
        st.concatJob?.cancel()
        val generation = ++st.concatGeneration
        st.concatJob = scope.launch {
            delay(concatDebounceMs)
            readAction {
                synchronized(lock) {
                    val concat = st.concat
                    if (byFile[st.file] !== st || concat == null || st.concatGeneration != generation) return@readAction
                    // Build, then send: no cancellable call after this point.
                    val text = NotebookCells.concatText(st.cells)
                    concat.version++
                    changeDoc(st, concat, text)
                }
            }
        }
    }

    private fun incrementalChange(st: State, doc: Doc, before: Cell, after: Cell, event: DocumentEvent) {
        doc.version++
        if (after.text.length > MAX_SYNC_CHARS || !doc.open) {
            changeDoc(st, doc, after.text)
            return
        }
        val start = NotebookCells.positionIn(before.text, event.offset - before.startOffset)
        val end = NotebookCells.positionIn(before.text, event.offset + event.oldLength - before.startOffset)
        sink.notify(DocumentSyncListener.DID_CHANGE, buildJsonObject {
            put("uri", doc.uri)
            put("version", doc.version)
            put("contentChanges", buildJsonArray {
                add(buildJsonObject {
                    put("range", buildJsonObject {
                        put("start", position(start))
                        put("end", position(end))
                    })
                    put("text", event.newFragment.toString())
                })
            })
        })
    }

    private fun position(p: Position) = buildJsonObject {
        put("line", p.line)
        put("character", p.character)
    }

    private fun openParams(st: State, doc: Doc, text: String) = buildJsonObject {
        put("uri", doc.uri)
        put("languageId", st.languageId)
        put("version", doc.version)
        put("text", text)
    }

    private fun openDoc(st: State, doc: Doc, text: String) {
        doc.open = false
        if (text.length > MAX_SYNC_CHARS) {
            LOG.info("LocalPilot: not syncing ${doc.uri} (${text.length} characters, above $MAX_SYNC_CHARS)")
            return
        }
        sink.notify(DocumentSyncListener.DID_OPEN, openParams(st, doc, text))
        doc.open = true
    }

    /** The doc's text changed and its version was bumped: whole-text `didChange`, or close / reopen across the cap. */
    private fun changeDoc(st: State, doc: Doc, text: String) {
        when {
            text.length > MAX_SYNC_CHARS -> closeDoc(doc)
            !doc.open -> openDoc(st, doc, text)
            else -> sink.notify(DocumentSyncListener.DID_CHANGE, buildJsonObject {
                put("uri", doc.uri)
                put("version", doc.version)
                put("contentChanges", buildJsonArray { add(buildJsonObject { put("text", text) }) })
            })
        }
    }

    private fun closeDoc(doc: Doc) {
        if (doc.open) sink.notify(DocumentSyncListener.DID_CLOSE, buildJsonObject { put("uri", doc.uri) })
        doc.open = false
    }

    private fun saveDoc(doc: Doc) {
        if (doc.open) sink.notify(DocumentSyncListener.DID_SAVE, buildJsonObject { put("uri", doc.uri) })
    }

    private companion object {
        val LOG = logger<NotebookCellSync>()
    }
}
