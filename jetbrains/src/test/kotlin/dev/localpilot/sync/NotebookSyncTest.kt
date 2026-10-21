package dev.localpilot.sync

import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.localpilot.rpc.CoreState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Path

/**
 * Notebook cell sync through [DocumentSyncListener] with a real `.ipynb`: the test IDE (PyCharm 2026.2) loads the
 * Jupyter plugin, whose text presentation turns the JSON into the `#%%` source Document the notebook editor edits.
 */
class NotebookSyncTest : BasePlatformTestCase() {
    private lateinit var sink: RecordingSink
    private lateinit var scope: CoroutineScope
    private lateinit var sync: DocumentSyncListener
    private lateinit var cells: NotebookCellSync

    override fun setUp() {
        super.setUp()
        sink = RecordingSink()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val workspace = Path.of(ModuleRootManager.getInstance(module).contentRoots.single().path)
        sync = DocumentSyncListener(project, sink, scope, testRootDisposable, workspace)
        cells = NotebookCellSync(sink, scope)
        sync.notebookSync = cells
        sync.install()
        sink.take()
    }

    override fun tearDown() {
        try {
            scope.cancel()
        } catch (e: Throwable) {
            addSuppressedException(e)
        } finally {
            super.tearDown()
        }
    }

    private fun notebookJson(language: String = "python", vararg cells: Pair<String, String>): String {
        val list = cells.joinToString(",") { (type, source) ->
            val src = source.split("\n").let { lines -> lines.mapIndexed { i, l -> if (i < lines.size - 1) "$l\n" else l } }
                .filter { it.isNotEmpty() }
                .joinToString(",") { "\"" + it.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"" }
            val extra = if (type == "code") ",\"outputs\":[],\"execution_count\":null" else ""
            """{"cell_type":"$type","metadata":{},"source":[$src]$extra}"""
        }
        return """{"cells":[$list],"metadata":{"kernelspec":{"display_name":"K","language":"$language","name":"k"},""" +
            """"language_info":{"name":"$language"}},"nbformat":4,"nbformat_minor":5}"""
    }

    /** code "import os\nx = 1", markdown "# Title", code "y = 2". */
    private fun openNotebook(language: String = "python"): VirtualFile =
        myFixture.configureByText(
            "nb.ipynb",
            notebookJson(language, "code" to "import os\nx = 1", "markdown" to "# Title", "code" to "y = 2"),
        ).virtualFile

    private fun docOf(file: VirtualFile): Document = FileDocumentManager.getInstance().getDocument(file)!!

    private fun edit(document: Document, block: Document.() -> Unit) =
        WriteCommandAction.runWriteCommandAction(project) { document.block() }

    private fun awaitCalls(count: Int): List<Pair<String, JsonObject>> {
        PlatformTestUtil.waitWithEventsDispatching(
            { "expected $count calls, got ${synchronized(sink.calls) { sink.calls.toList() }}" },
            { synchronized(sink.calls) { sink.calls.size >= count } },
            10,
        )
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        return sink.take()
    }

    private fun summary(calls: List<Pair<String, JsonObject>>, base: String): List<String> = calls.map { (method, p) ->
        val uri = p["uri"]!!.jsonPrimitive.content.removePrefix(base)
        val version = p["version"]?.jsonPrimitive?.int
        "${method.removePrefix("textDocument/")} $uri" + (version?.let { " v$it" } ?: "")
    }

    private fun text(p: JsonObject): String =
        p["text"]?.jsonPrimitive?.content ?: p["contentChanges"]!!.jsonArray.single().jsonObject["text"]!!.jsonPrimitive.content

    fun test_opens_code_cells_and_concat_markdown_skipped() {
        val file = openNotebook()
        val base = documentUri(file)
        assertEquals("#%%\nimport os\nx = 1\n#%% md\n# Title\n#%%\ny = 2", docOf(file).text)
        val opened = sink.take()
        assertEquals(listOf("didOpen .cell0.py v1", "didOpen .cell2.py v1", "didOpen .cells.py v1"), summary(opened, base))
        assertEquals(listOf("import os\nx = 1", "y = 2", "import os\nx = 1\n\ny = 2"), opened.map { text(it.second) })
        assertTrue(opened.all { it.second["languageId"]!!.jsonPrimitive.content == "python" })
        assertTrue(cells.isNotebookDocument(docOf(file)))
        assertNull(sync.versionOf(file))
    }

    fun test_typing_in_cell_sends_cell_relative_change_then_debounced_concat() {
        val file = openNotebook()
        val base = documentUri(file)
        val document = docOf(file)
        sink.take()

        edit(document) { insertString(text.indexOf("x = 1") + 5, "\nz") }
        val change = sink.take()
        assertEquals(listOf("didChange .cell0.py v2"), summary(change, base))
        val c = change.single().second["contentChanges"]!!.jsonArray.single().jsonObject
        assertEquals("{\"start\":{\"line\":1,\"character\":5},\"end\":{\"line\":1,\"character\":5}}", c["range"].toString())
        assertEquals("\nz", c["text"]!!.jsonPrimitive.content)

        // Two quick edits: one concat re-send with the final text, ~200 ms later.
        edit(document) { insertString(text.indexOf("y = 2") + 5, "3") }
        assertEquals(listOf("didChange .cell2.py v2"), summary(sink.take(), base))
        val concat = awaitCalls(1)
        assertEquals(listOf("didChange .cells.py v2"), summary(concat, base))
        assertEquals("import os\nx = 1\nz\n\ny = 23", text(concat.single().second))
        Thread.sleep(300)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals(emptyList<Any>(), sink.take())
    }

    fun test_insert_cell_above_reopens_shifted_cells_and_locate_follows() {
        val file = openNotebook()
        val base = documentUri(file)
        val document = docOf(file)
        sink.take()
        val caretBefore = document.text.indexOf("= 2")
        assertEquals("$base.cell2.py" to Position(0, 2), cells.locate(document, caretBefore)!!.let { it.uri to it.position })

        val inserted = "#%%\nnew = 0\n"
        edit(document) { insertString(0, inserted) }
        val calls = sink.take()
        assertEquals(
            listOf(
                "didClose .cell0.py", "didClose .cell2.py",
                "didOpen .cell0.py v1", "didOpen .cell1.py v1", "didOpen .cell3.py v1",
            ),
            summary(calls, base),
        )
        assertEquals(listOf("new = 0", "import os\nx = 1", "y = 2"), calls.drop(2).map { text(it.second) })

        val loc = cells.locate(document, caretBefore + inserted.length)!!
        assertEquals("$base.cell3.py", loc.uri)
        assertEquals(Position(0, 2), loc.position)
        assertEquals(3, loc.cell.index)
        assertNull(cells.locate(document, document.text.indexOf("Title")))

        // A later edit in the moved cell goes to its new uri, versions restarted at 1.
        edit(document) { insertString(text.indexOf("y = 2"), "#") }
        assertEquals(listOf("didChange .cell3.py v2"), summary(sink.take(), base))
        assertEquals(listOf("didChange .cells.py v2"), summary(awaitCalls(1), base))
    }

    fun test_delete_cell_and_cross_cell_edit_reconcile() {
        val file = openNotebook()
        val base = documentUri(file)
        val document = docOf(file)
        sink.take()

        // Delete the first (code) cell with its marker: the markdown and last code cell shift down by one.
        edit(document) { deleteString(0, text.indexOf("#%% md")) }
        assertEquals("#%% md\n# Title\n#%%\ny = 2", document.text)
        assertEquals(listOf("didClose .cell0.py", "didClose .cell2.py", "didOpen .cell1.py v1"), summary(sink.take(), base))

        // A replace spanning the markdown cell into the code cell: both merge into one code cell 0.
        edit(document) { replaceString(0, text.indexOf("y = 2"), "#%%\n") }
        assertEquals("#%%\ny = 2", document.text)
        assertEquals(listOf("didClose .cell1.py", "didOpen .cell0.py v1"), summary(sink.take(), base))
        val concat = awaitCalls(1)
        assertEquals(listOf("didChange .cells.py v2"), summary(concat, base))
        assertEquals("y = 2", text(concat.single().second))

        // Turning the only code cell into markdown closes everything, including the concat.
        edit(document) { insertString(3, " md") }
        assertEquals(listOf("didClose .cell0.py", "didClose .cells.py"), summary(sink.take(), base))
    }

    fun test_edit_shifting_text_in_place_sends_whole_text_for_same_uri() {
        val file = openNotebook()
        val base = documentUri(file)
        val document = docOf(file)
        sink.take()
        // Splitting cell 0 with a new marker: cell 0 keeps its uri (whole text), the new code cell 1 is opened, and
        // the markdown + last code cell shift by one.
        edit(document) { insertString(text.indexOf("x = 1"), "#%%\n") }
        assertEquals(
            listOf(
                "didClose .cell2.py",
                "didChange .cell0.py v2", "didOpen .cell1.py v1", "didOpen .cell3.py v1",
            ),
            summary(sink.take(), base),
        )
    }

    fun test_edit_spanning_cells_keeps_untouched_cells_quiet() {
        val file = openNotebook()
        val base = documentUri(file)
        val document = docOf(file)
        sink.take()
        // From inside cell 0 into the markdown cell, same cell count: cell 0 gets its whole new text, the code cell
        // after the edit keeps its uri and text, so nothing is sent for it.
        edit(document) {
            val start = text.indexOf("x = 1")
            replaceString(start, text.indexOf("# Title") + "# Title".length, "x = 2\n#%% md\n# T2")
        }
        val calls = sink.take()
        assertEquals(listOf("didChange .cell0.py v2"), summary(calls, base))
        assertEquals("import os\nx = 2", text(calls.single().second))
        assertEquals(listOf("didChange .cells.py v2"), summary(awaitCalls(1), base))
    }

    fun test_save_close_and_replay() {
        val file = openNotebook()
        val base = documentUri(file)
        val document = docOf(file)
        sink.take()
        edit(document) { insertString(text.indexOf("y = 2"), "#") }
        sink.take()

        FileDocumentManager.getInstance().saveDocument(document)
        val saved = sink.take().filter { it.first == DocumentSyncListener.DID_SAVE }
        assertEquals(listOf("didSave .cell0.py", "didSave .cell2.py", "didSave .cells.py"), summary(saved, base))
        awaitCalls(1) // the debounced concat

        sink.state.value = CoreState.CRASHED
        sink.state.value = CoreState.STARTING
        assertEquals(emptyList<Any>(), sink.take())
        sink.state.value = CoreState.READY
        val replayed = awaitCalls(3)
        assertEquals(listOf("didOpen .cell0.py v1", "didOpen .cell2.py v2", "didOpen .cells.py v2"), summary(replayed, base))
        assertEquals("#y = 2", text(replayed[1].second))

        FileEditorManager.getInstance(project).closeFile(file)
        assertEquals(listOf("didClose .cell0.py", "didClose .cell2.py", "didClose .cells.py"), summary(sink.take(), base))
        assertFalse(cells.isNotebookDocument(document))
        edit(document) { insertString(0, "#%%\nq\n") }
        assertEquals(emptyList<Any>(), sink.take())
    }

    fun test_kernel_language_sets_language_id_and_ext() {
        val file = openNotebook("R")
        val base = documentUri(file)
        val opened = sink.take()
        assertEquals(listOf("didOpen .cell0.r v1", "didOpen .cell2.r v1", "didOpen .cells.r v1"), summary(opened, base))
        assertTrue(opened.all { it.second["languageId"]!!.jsonPrimitive.content == "r" })
        val target = cells.cellForUri("$base.cell2.r")!!
        assertEquals(2, target.cell.index)
        assertEquals("y = 2", target.document.text.substring(target.cell.startOffset, target.cell.endOffset))
        assertNull(cells.cellForUri("$base.cells.r"))
        assertNull(cells.cellForUri("$base.cell1.r"))
    }
}
