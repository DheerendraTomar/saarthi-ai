package dev.localpilot.sync

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.editor.Document
import com.intellij.openapi.vfs.VirtualFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.IOException

enum class CellKind { CODE, MARKDOWN, RAW }

/**
 * One notebook cell in the notebook editor's Document.
 *
 * - [index]: the cell's index in the notebook (markdown/raw cells count), the `<i>` of its virtual uri.
 * - [markerOffset]: start of its `#%%` marker line.
 * - [startOffset]/[endOffset]: its content (the line after the marker up to, not including, the `\n` before the
 *   next marker; or the document end). Content always starts at a line start.
 * - [text]: the content, exactly as in the Document.
 * - [id]: always null: the source rendering carries no nbformat cell ids.
 */
data class Cell(
    val index: Int,
    val kind: CellKind,
    val language: String,
    val markerOffset: Int,
    val startOffset: Int,
    val endOffset: Int,
    val text: String,
    val id: String? = null,
)

/** Wire position: 0-based line, `character` in UTF-16 code units. */
data class Position(val line: Int, val character: Int)

/**
 * `.ipynb` → cells, virtual uris, the concatenated doc and caret → cell mapping.
 *
 * **How PyCharm 2026.2 shows a notebook.** The `.ipynb` VirtualFile is the real local file (`Jupyter` file type, raw
 * JSON bytes on disk), but its Document — the one the notebook editor edits and [DocumentSyncListener] sees — is the
 * Jupyter plugin's *source rendering* (`JupyterTextPresentationTransformer.fromPersistent` →
 * `JupyterNotebookBase.asSource()`): the cells joined by `\n`, each one `#%%<suffix>\n<source>` with suffix `""` for
 * code, `" md"` for markdown, `" raw"` for raw (and `" sql"`, `" heading"`, … for PyCharm's own cell kinds). A source
 * line that starts with `#%%` is escaped as `##%%`, so every line starting with `#%%` is a marker. The platform's
 * `NotebookCellLines` (notebooks.visualization) computes the same intervals from this text, but only once the
 * notebook editor installed its provider, and it updates them from its own DocumentListener, whose order relative to
 * ours is not defined. So this parses the Document text itself: always consistent with the event being handled,
 * and no dependency on the notebooks module (the plugin stays loadable in any IntelliJ IDE).
 *
 * A Document that does not start with a marker (raw JSON in an IDE without the notebook editor, an empty file) has
 * no cells and is not synced.
 */
object NotebookCells {
    const val MARKER = "#%%"

    private val LOG = logger<NotebookCells>()

    /** Same table as `vscode/src/notebookUris.ts` and `jupyterlab/src/cellUri.ts`; unknown → `txt`. */
    private val EXT_BY_LANGUAGE = mapOf("python" to "py", "javascript" to "js", "typescript" to "ts", "r" to "r", "julia" to "jl")

    /** The kernel language when the notebook declares none (PyCharm's notebooks are Python). */
    const val DEFAULT_LANGUAGE = "python"

    fun extForLanguage(language: String): String = EXT_BY_LANGUAGE[language.lowercase()] ?: "txt"

    /** Cells of the notebook Document [document] of [file] (read action). */
    fun forDocument(document: Document, file: VirtualFile): List<Cell> = parse(document.immutableCharSequence, kernelLanguage(file))

    /** Cells of a `#%%` source rendering; code cells get [language] (the kernel language). */
    fun parse(text: CharSequence, language: String): List<Cell> {
        if (!isMarkerLine(text, 0)) return emptyList()
        val markers = ArrayList<Int>()
        var lineStart = 0
        while (lineStart <= text.length) {
            if (isMarkerLine(text, lineStart)) markers += lineStart
            val nl = indexOf(text, '\n', lineStart)
            if (nl < 0) break
            lineStart = nl + 1
        }
        return markers.mapIndexed { i, marker ->
            val nl = indexOf(text, '\n', marker)
            val header = text.subSequence(marker + MARKER.length, if (nl < 0) text.length else nl).toString().trim()
            val start = if (nl < 0) text.length else nl + 1
            val end = if (i + 1 < markers.size) markers[i + 1] - 1 else text.length
            val kind = when (header) {
                "" -> CellKind.CODE
                "md" -> CellKind.MARKDOWN
                else -> CellKind.RAW
            }
            val lang = when (kind) {
                CellKind.CODE -> language
                CellKind.MARKDOWN -> "markdown"
                CellKind.RAW -> "raw"
            }
            Cell(i, kind, lang, marker, start, maxOf(start, end), text.subSequence(start, maxOf(start, end)).toString())
        }
    }

    private fun isMarkerLine(text: CharSequence, lineStart: Int): Boolean =
        lineStart + MARKER.length <= text.length && text.regionMatches(lineStart, MARKER, 0, MARKER.length)

    private fun indexOf(text: CharSequence, c: Char, from: Int): Int {
        for (i in from until text.length) if (text[i] == c) return i
        return -1
    }

    fun codeCells(cells: List<Cell>): List<Cell> = cells.filter { it.kind == CellKind.CODE }

    /**
     * The code cell holding [offset] (a Document offset; the content end counts as inside) and the position relative
     * to the cell's start; null in markdown/raw cells, on marker lines, and outside any cell.
     */
    fun caretToCell(cells: List<Cell>, offset: Int): Pair<Cell, Position>? {
        val cell = cells.firstOrNull { offset >= it.startOffset && offset <= it.endOffset } ?: return null
        if (cell.kind != CellKind.CODE) return null
        return cell to positionIn(cell.text, offset - cell.startOffset)
    }

    /** `{line, character}` of [offset] in [text] (UTF-16 units, `\n` line separators). */
    fun positionIn(text: CharSequence, offset: Int): Position {
        var line = 0
        var lineStart = 0
        for (i in 0 until offset) if (text[i] == '\n') {
            line++
            lineStart = i + 1
        }
        return Position(line, offset - lineStart)
    }

    /** `<notebook uri>.cell<i>.<ext>`: the notebook's [documentUri] with the suffix appended (same scheme as VS Code/JupyterLab). */
    fun cellUri(notebookUri: String, index: Int, ext: String): String = "$notebookUri.cell$index.$ext"

    fun cellUri(file: VirtualFile, index: Int, ext: String): String = cellUri(documentUri(file), index, ext)

    /** `<notebook uri>.cells.<ext>`: every code cell concatenated ([concatText]). */
    fun concatUri(notebookUri: String, ext: String): String = "$notebookUri.cells.$ext"

    fun concatUri(file: VirtualFile, ext: String): String = concatUri(documentUri(file), ext)

    /** All code cells, in order, separated by a blank line (as the VS Code and JupyterLab clients). */
    fun concatText(cells: List<Cell>): String = codeCells(cells).joinToString("\n\n") { it.text }

    /**
     * The kernel language of [file] (lowercase), from the `.ipynb` JSON on disk (the VirtualFile's bytes are the
     * JSON; only the Document is the source rendering); [DEFAULT_LANGUAGE] when it declares none or cannot be read.
     */
    fun kernelLanguage(file: VirtualFile): String {
        val json = try {
            String(file.contentsToByteArray(), Charsets.UTF_8)
        } catch (e: IOException) {
            LOG.info("LocalPilot: cannot read ${file.path} for its kernel language: ${e.message}")
            return DEFAULT_LANGUAGE
        }
        return kernelLanguageOf(json) ?: DEFAULT_LANGUAGE
    }

    /**
     * `metadata.language_info.name`, else `metadata.kernelspec.language` (JupyterLab's order), lowercase; null if
     * neither is there. Only the two small objects are parsed (the last occurrence of each key: the notebook
     * metadata follows the cells, and a key quoted inside a cell's source is escaped), not the whole notebook.
     */
    fun kernelLanguageOf(json: String): String? {
        fun field(key: String, name: String): String? {
            val match = Regex("\"$key\"\\s*:\\s*\\{").findAll(json).lastOrNull() ?: return null
            val obj = balancedObject(json, match.range.last) ?: return null
            val value = try {
                (Json.parseToJsonElement(obj) as? JsonObject)?.get(name) as? JsonPrimitive
            } catch (_: Exception) {
                null
            }
            return value?.takeIf { it.isString }?.content?.lowercase()?.takeIf { it.isNotBlank() }
        }
        return field("language_info", "name") ?: field("kernelspec", "language")
    }

    /** The JSON object starting at the `{` at [open] (string-aware brace matching), or null if unbalanced. */
    private fun balancedObject(s: String, open: Int): String? {
        var depth = 0
        var inString = false
        var i = open
        while (i < s.length) {
            val c = s[i]
            if (inString) {
                if (c == '\\') i++ else if (c == '"') inString = false
            } else when (c) {
                '"' -> inString = true
                '{' -> depth++
                '}' -> if (--depth == 0) return s.substring(open, i + 1)
            }
            i++
        }
        return null
    }
}
