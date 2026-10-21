package dev.localpilot.chat

import com.intellij.openapi.application.EDT
import com.intellij.openapi.application.readAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import dev.localpilot.sync.CellTarget
import dev.localpilot.sync.DocumentSyncService
import dev.localpilot.sync.Position
import dev.localpilot.sync.isNotebookFile
import dev.localpilot.sync.workspaceOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.URI
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path

/**
 * The core's `workspace/applyEdit` request (core/src/protocol.rs `ApplyEditParams` → `ApplyEditResult`
 * `{ applied, error? }`), the counterpart of the VS Code host's `vscode/src/chat/applyEdit.ts`.
 *
 * - Every op is validated first (uri, workspace confinement, targets); then all ops are applied **in order** in one
 *   `WriteCommandAction` (one undo step). `edit` → `Document.replaceString` with UTF-16 offsets from the wire
 *   `{line, character}` (out-of-range positions are an error, not clamped: the core computed them from the text it
 *   was synced, so a mismatch means stale state). Files not open are loaded through `FileDocumentManager`.
 *   `create` → the file (and missing parent folders) is created with the content written to disk; an existing file
 *   is an error (never overwritten).
 * - Virtual notebook cell uris `<nb>.ipynb.cell<i>.<ext>` edit that code cell's range of the open notebook's `#%%`
 *   Document (via [cellForUri], Task 4); positions are relative to the cell's text exactly as it is synced (escaped
 *   `##%%` lines included). A line of the result that would start with `#%%` is escaped as `##%%`, as the Jupyter
 *   plugin escapes cell sources, so an edit can never split the cell. Files are never created at `.cell<i>.<ext>`
 *   paths; the read-only concat doc `.cells.<ext>` is refused; a whole `.ipynb` is refused (its Document is the
 *   `#%%` rendering, not the JSON the core's positions would refer to).
 * - Plain file uris must be `file:` paths strictly inside [workspace] (as spelled, and through symlinks for the
 *   nearest existing ancestor, like the core's `confine`).
 * - `save: true` → `FileDocumentManager.saveDocument` for the edited documents only (a cell's notebook Document
 *   once); other unsaved documents are left alone.
 * - Never throws (except coroutine cancellation): failures are returned as `{ applied: false, error }`; a save
 *   failure after a successful edit is `{ applied: true, error }` as in VS Code.
 *
 * Implements 5b's [EditApplier] (`chat/HostHooks.kt`).
 */
class ApplyEdit(
    private val project: Project,
    private val workspace: Path? = workspaceOf(project),
    private val cellForUri: (String) -> CellTarget? = { DocumentSyncService.getInstance(project).notebookCells?.cellForUri(it) },
) : EditApplier {
    private class EditFailure(message: String) : Exception(message)

    private sealed interface Op {
        val uri: String
    }

    private data class Range(val start: Position, val end: Position)
    private class FileEdit(override val uri: String, val path: Path, var document: Document?, val range: Range, val newText: String) : Op
    private class CellEdit(override val uri: String, val range: Range, val newText: String) : Op
    private class Create(override val uri: String, val path: Path, val content: String) : Op

    override suspend fun apply(params: JsonElement): JsonElement {
        return try {
            val (ops, save) = parse(params)
            val prepared = withContext(Dispatchers.IO) { prepare(ops) }
            val touched = LinkedHashMap<Document, String>()
            withContext(Dispatchers.EDT) {
                WriteCommandAction.writeCommandAction(project).withName("LocalPilot Edit").withGlobalUndo().run<EditFailure> {
                    for ((i, op) in prepared.withIndex()) {
                        try {
                            execute(op)?.let { touched.putIfAbsent(it, op.uri) }
                        } catch (e: EditFailure) {
                            val note = if (i > 0) " (the earlier ops of this request were applied)" else ""
                            throw EditFailure("${e.message}$note")
                        }
                    }
                }
            }
            if (!save || touched.isEmpty()) return result(true)
            val unsaved = save(touched)
            if (unsaved.isEmpty()) result(true) else result(true, "applied but could not save ${unsaved.joinToString(", ")}")
        } catch (e: CancellationException) {
            throw e
        } catch (e: ProcessCanceledException) {
            throw e
        } catch (e: EditFailure) {
            result(false, e.message)
        } catch (e: Throwable) {
            LOG.warn("applyEdit failed", e)
            result(false, "applying the edit failed: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    // ---------------------------------------------------------------- parsing and validation (off the EDT)

    private fun parse(params: JsonElement): Pair<List<JsonObject>, Boolean> {
        val obj = params as? JsonObject ?: throw EditFailure("invalid edit: expected an object")
        val ops = (obj["ops"] ?: throw EditFailure("invalid edit: missing \"ops\"")).let {
            runCatching { it.jsonArray.map { op -> op.jsonObject } }.getOrNull() ?: throw EditFailure("invalid edit: \"ops\" must be an array of objects")
        }
        val save = (obj["save"] as? JsonPrimitive)?.booleanOrNull ?: false
        return ops to save
    }

    private fun string(op: JsonObject, key: String): String =
        (op[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw EditFailure("invalid edit: missing \"$key\"")

    private fun parseRange(op: JsonObject): Range {
        fun pos(key: String): Position {
            val p = runCatching { op["range"]!!.jsonObject[key]!!.jsonObject }.getOrNull() ?: throw EditFailure("invalid edit: bad range")
            val line = (p["line"] as? JsonPrimitive)?.intOrNull
            val character = (p["character"] as? JsonPrimitive)?.intOrNull
            if (line == null || character == null || line < 0 || character < 0) throw EditFailure("invalid edit: bad range")
            return Position(line, character)
        }
        return Range(pos("start"), pos("end"))
    }

    private suspend fun prepare(ops: List<JsonObject>): List<Op> {
        val created = HashSet<Path>()
        return ops.map { op ->
            val kind = (op["kind"] as? JsonPrimitive)?.content
            val uri = string(op, "uri")
            if (kind != "edit" && kind != "create") throw EditFailure("unknown edit op ${op["kind"] ?: "(none)"}")
            val path = toPath(uri)
            val name = path.fileName?.toString() ?: ""
            if (CONCAT_NAME.matches(name)) {
                throw EditFailure("$uri is the read-only view of a notebook's cells; edit a single cell (.cell<N>) instead")
            }
            if (CELL_NAME.matches(name)) {
                if (kind == "create") throw EditFailure("LocalPilot can't create notebook cells ($uri)")
                // Resolved again inside the write action (an earlier op may have moved the cell's offsets).
                if (cellForUri(uri) == null) throw EditFailure("cannot edit $uri: that notebook cell is not open")
                return@map CellEdit(uri, parseRange(op), StringUtil.convertLineSeparators(string(op, "newText")))
            }
            confine(path, uri)
            if (kind == "create") {
                if (Files.exists(path, LinkOption.NOFOLLOW_LINKS) || path in created) throw EditFailure("cannot create $uri: it already exists")
                created.add(path)
                Create(uri, path, string(op, "content"))
            } else {
                val range = parseRange(op)
                val newText = StringUtil.convertLineSeparators(string(op, "newText"))
                if (path in created) return@map FileEdit(uri, path, null, range, newText)
                if (path.fileName.toString().endsWith(".ipynb", ignoreCase = true)) throw notebookFile(uri)
                val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path)
                    ?: throw EditFailure("cannot open $uri: no such file")
                FileEdit(uri, path, documentOf(file, uri), range, newText)
            }
        }
    }

    private fun notebookFile(uri: String) =
        EditFailure("cannot edit $uri as text: edit a notebook through its cells (<notebook>.ipynb.cell<N>.<ext>)")

    private suspend fun documentOf(file: VirtualFile, uri: String): Document {
        if (file.isDirectory) throw EditFailure("cannot edit $uri: it is a folder")
        if (isNotebookFile(file)) throw notebookFile(uri)
        return readAction { FileDocumentManager.getInstance().getDocument(file) }
            ?: throw EditFailure("cannot open $uri: not a text file")
    }

    private fun toPath(uri: String): Path {
        val parsed = try {
            URI(uri)
        } catch (e: Exception) {
            throw EditFailure("invalid uri $uri: ${e.message}")
        }
        if (!parsed.scheme.equals("file", ignoreCase = true)) throw EditFailure("cannot edit $uri: only file: uris are supported")
        return try {
            Path.of(parsed)
        } catch (e: Exception) {
            throw EditFailure("invalid uri $uri: ${e.message}")
        }
    }

    private fun confine(path: Path, uri: String) {
        val root = workspace ?: throw EditFailure("cannot edit $uri: the project has no folder")
        if (!isConfined(root, path)) throw EditFailure("cannot edit $uri: the path is outside the workspace")
    }

    // ---------------------------------------------------------------- applying (inside the write command)

    /** Applies [op]; returns the Document to save (null for a created file, which is written to disk directly). */
    private fun execute(op: Op): Document? = when (op) {
        is Create -> {
            val parentPath = op.path.parent ?: throw EditFailure("cannot create ${op.uri}")
            val parent = VfsUtil.createDirectories(parentPath.toString())
            if (parent.findChild(op.path.fileName.toString()) != null) throw EditFailure("cannot create ${op.uri}: it already exists")
            val file = parent.createChildData(this, op.path.fileName.toString())
            VfsUtil.saveText(file, op.content)
            null
        }
        is FileEdit -> {
            val document = op.document ?: run {
                val file = LocalFileSystem.getInstance().findFileByNioFile(op.path) ?: throw EditFailure("cannot open ${op.uri}: no such file")
                FileDocumentManager.getInstance().getDocument(file) ?: throw EditFailure("cannot open ${op.uri}: not a text file")
            }
            if (!document.isWritable) throw EditFailure("cannot edit ${op.uri}: the file is read-only")
            val text = document.immutableCharSequence
            val start = offsetOf(text, op.range.start) ?: throw outOfRange(op.uri, op.range)
            val end = offsetOf(text, op.range.end) ?: throw outOfRange(op.uri, op.range)
            if (end < start) throw outOfRange(op.uri, op.range)
            document.replaceString(start, end, op.newText)
            document
        }
        is CellEdit -> {
            val target = cellForUri(op.uri) ?: throw EditFailure("cannot edit ${op.uri}: that notebook cell is not open")
            val document = target.document
            if (!document.isWritable) throw EditFailure("cannot edit ${op.uri}: the notebook is read-only")
            val cellStart = target.cell.startOffset
            val cellText = document.immutableCharSequence.subSequence(cellStart, target.cell.endOffset).toString()
            val replacement = cellReplacement(cellText, op.range.start, op.range.end, op.newText) ?: throw outOfRange(op.uri, op.range)
            if (replacement.text.isNotEmpty() || replacement.end > replacement.start) {
                document.replaceString(cellStart + replacement.start, cellStart + replacement.end, replacement.text)
            }
            document
        }
    }

    private fun outOfRange(uri: String, range: Range) = EditFailure(
        "cannot edit $uri: range ${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character} " +
            "is outside the document (it may have changed; read it again)",
    )

    // ---------------------------------------------------------------- saving

    private suspend fun save(touched: Map<Document, String>): List<String> = withContext(Dispatchers.EDT) {
        val fdm = FileDocumentManager.getInstance()
        touched.mapNotNull { (document, uri) ->
            try {
                fdm.saveDocument(document)
                if (fdm.isDocumentUnsaved(document)) uri else null
            } catch (e: CancellationException) {
                throw e
            } catch (e: ProcessCanceledException) {
                throw e
            } catch (e: Exception) {
                "$uri (${e.message})"
            }
        }
    }

    companion object {
        private val LOG = logger<ApplyEdit>()

        /** `<nb>.ipynb.cells.<ext>`: the read-only concatenation of a notebook's code cells. */
        private val CONCAT_NAME = Regex(""".*\.ipynb\.cells\.[^./\\]+""", RegexOption.IGNORE_CASE)

        /** `<nb>.ipynb.cell<i>.<ext>`: one code cell, synced under a virtual file path. */
        private val CELL_NAME = Regex(""".*\.ipynb\.cell\d+\.[^./\\]+""", RegexOption.IGNORE_CASE)

        private fun result(applied: Boolean, error: String? = null): JsonElement = buildJsonObject {
            put("applied", applied)
            if (error != null) put("error", error)
        }

        /**
         * UTF-16 offset of [pos] in [text] (lines split at `\n`); null if the line does not exist or the character is
         * past the end of the line.
         */
        fun offsetOf(text: CharSequence, pos: Position): Int? {
            var lineStart = 0
            repeat(pos.line) {
                val nl = text.indexOf('\n', lineStart)
                if (nl < 0) return null
                lineStart = nl + 1
            }
            val lineEnd = text.indexOf('\n', lineStart).let { if (it < 0) text.length else it }
            return if (pos.character <= lineEnd - lineStart) lineStart + pos.character else null
        }

        /** Replace `[start, end)` of a cell's text with [text]. */
        data class CellReplacement(val start: Int, val end: Int, val text: String)

        /**
         * The edit of a notebook cell, in offsets of the cell's text: `[startPos, endPos)` replaced by [newText], with every line
         * of the result that starts with `#%%` (which would become a cell marker) escaped as `##%%`, the way the
         * Jupyter plugin renders such source lines. Lines outside the edited span never start with `#%%` (a cell's
         * text contains no marker lines), so only the lines touched by the edit are checked — including a marker
         * completed from text that was already there. The returned replacement is trimmed to the changed part.
         * Null if the range is outside [cellText].
         */
        fun cellReplacement(cellText: String, startPos: Position, endPos: Position, newText: String): CellReplacement? {
            val start = offsetOf(cellText, startPos) ?: return null
            val end = offsetOf(cellText, endPos) ?: return null
            if (end < start) return null
            val result = cellText.substring(0, start) + newText + cellText.substring(end)
            val spanStart = cellText.lastIndexOf('\n', start - 1) + 1
            val oldSpanEnd = cellText.indexOf('\n', end).let { if (it < 0) cellText.length else it }
            val newSpanEnd = result.indexOf('\n', start + newText.length).let { if (it < 0) result.length else it }
            val escaped = result.substring(spanStart, newSpanEnd).split('\n')
                .joinToString("\n") { if (it.startsWith("#%%")) "#$it" else it }
            val old = cellText.substring(spanStart, oldSpanEnd)
            // Trim the common prefix/suffix so the Document edit (and the cell's didChange) stays minimal.
            var prefix = 0
            val maxPrefix = minOf(old.length, escaped.length)
            while (prefix < maxPrefix && old[prefix] == escaped[prefix]) prefix++
            var suffix = 0
            while (suffix < minOf(old.length, escaped.length) - prefix &&
                old[old.length - 1 - suffix] == escaped[escaped.length - 1 - suffix]
            ) suffix++
            return CellReplacement(spanStart + prefix, oldSpanEnd - suffix, escaped.substring(prefix, escaped.length - suffix))
        }

        /**
         * True if [path] is strictly inside [root]: no `..` component, inside as spelled (normalized), and the nearest
         * existing ancestor of [path] resolves (through symlinks) inside the real root — so a symlink in the
         * workspace pointing outside it does not let an edit or a create escape. Mirrors the core's `confine`.
         */
        fun isConfined(root: Path, path: Path): Boolean {
            if (path.any { it.toString() == ".." }) return false
            val abs = path.toAbsolutePath().normalize()
            val absRoot = root.toAbsolutePath().normalize()
            if (abs == absRoot || !abs.startsWith(absRoot)) return false
            return try {
                val realRoot = absRoot.toRealPath()
                var existing: Path? = abs
                while (existing != null && !Files.exists(existing, LinkOption.NOFOLLOW_LINKS)) existing = existing.parent
                if (existing == null) return false
                val real = existing.toRealPath()
                real == realRoot && existing != abs || real.startsWith(realRoot) && real != realRoot
            } catch (_: IOException) {
                false
            } catch (_: SecurityException) {
                false
            }
        }
    }
}
