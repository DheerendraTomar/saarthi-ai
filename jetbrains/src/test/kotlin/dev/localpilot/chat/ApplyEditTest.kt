package dev.localpilot.chat

import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.localpilot.sync.DocumentSyncListener
import dev.localpilot.sync.NotebookCellSync
import dev.localpilot.sync.RecordingSink
import dev.localpilot.sync.documentUri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.nio.file.Path

/**
 * `workspace/applyEdit` against real files in a temp workspace folder, and against a notebook opened through the
 * Jupyter plugin's `#%%` text presentation (the same setup as NotebookSyncTest). [ApplyEdit.apply] is called from a
 * background thread (`runBlocking` on a pooled thread), as the core's request handler would.
 */
class ApplyEditTest : BasePlatformTestCase() {
    private lateinit var workspace: File
    private val tempDirs = mutableListOf<File>()

    override fun setUp() {
        super.setUp()
        workspace = tempDir("ws")
    }

    override fun tearDown() {
        try {
            for (dir in tempDirs) FileUtil.delete(dir)
        } catch (e: Throwable) {
            addSuppressedException(e)
        } finally {
            super.tearDown()
        }
    }

    private fun tempDir(prefix: String): File = FileUtil.createTempDirectory(prefix, null).also { tempDirs += it }

    private fun localFile(path: File, text: String): VirtualFile {
        path.parentFile.mkdirs()
        path.writeText(text)
        return LocalFileSystem.getInstance().refreshAndFindFileByIoFile(path)!!
    }

    private fun docOf(file: VirtualFile): Document = FileDocumentManager.getInstance().getDocument(file)!!

    private fun edit(document: Document, block: Document.() -> Unit) =
        WriteCommandAction.runWriteCommandAction(project) { document.block() }

    private fun range(l1: Int, c1: Int, l2: Int, c2: Int) = buildJsonObject {
        put("start", buildJsonObject { put("line", l1); put("character", c1) })
        put("end", buildJsonObject { put("line", l2); put("character", c2) })
    }

    private fun editOp(uri: String, range: JsonObject, newText: String) = buildJsonObject {
        put("kind", "edit"); put("uri", uri); put("range", range); put("newText", newText)
    }

    private fun createOp(uri: String, content: String) = buildJsonObject {
        put("kind", "create"); put("uri", uri); put("content", content)
    }

    private fun params(vararg ops: JsonObject, save: Boolean = true) = buildJsonObject {
        put("ops", buildJsonArray { ops.forEach { add(it) } })
        put("save", save)
        put("sessionId", "s1")
    }

    /** Runs [ApplyEdit.apply] off the EDT while the EDT keeps pumping events (write actions and saves need it). */
    private fun apply(applier: ApplyEdit, params: JsonElement): JsonObject {
        var result: JsonElement? = null
        var error: Throwable? = null
        val thread = Thread {
            try {
                result = runBlocking { applier.apply(params) }
            } catch (e: Throwable) {
                error = e
            }
        }
        thread.start()
        com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching(
            "applyEdit did not finish", { !thread.isAlive }, 20,
        )
        error?.let { throw it }
        return result!!.jsonObject
    }

    private fun applier(cells: (String) -> dev.localpilot.sync.CellTarget? = { null }) =
        ApplyEdit(project, workspace.toPath(), cells)

    private fun applied(result: JsonObject) = result["applied"]!!.jsonPrimitive.boolean
    private fun error(result: JsonObject) = result["error"]?.jsonPrimitive?.content

    fun test_applyEdit_replaces_range_and_saves_only_touched() {
        val a = localFile(File(workspace, "src/a.txt"), "hello 😀 world\nsecond line\n")
        val b = localFile(File(workspace, "src/b.txt"), "bee\n")
        val docA = docOf(a)
        val docB = docOf(b)
        // Both documents have unsaved changes; only the edited one may be saved.
        edit(docA) { insertString(textLength, "tail") }
        edit(docB) { insertString(0, "unsaved ") }

        // UTF-16: the emoji is two code units, so "world" starts at character 9.
        val result = apply(applier(), params(editOp(documentUri(a), range(0, 9, 1, 6), "there\nfirst")))
        assertTrue(result.toString(), applied(result))
        assertNull(error(result))
        assertEquals("hello 😀 there\nfirst line\ntail", docA.text)
        val fdm = FileDocumentManager.getInstance()
        assertFalse(fdm.isDocumentUnsaved(docA))
        assertEquals("hello 😀 there\nfirst line\ntail", File(workspace, "src/a.txt").readText())
        assertTrue(fdm.isDocumentUnsaved(docB))
        assertEquals("bee\n", File(workspace, "src/b.txt").readText())

        // save = false leaves the edit in the editor only; CRLF in newText is normalised for the Document.
        val r2 = apply(applier(), params(editOp(documentUri(a), range(2, 0, 2, 4), "x\r\ny"), save = false))
        assertTrue(r2.toString(), applied(r2))
        assertEquals("hello 😀 there\nfirst line\nx\ny", docA.text)
        assertTrue(fdm.isDocumentUnsaved(docA))
    }

    fun test_applyEdit_edits_file_not_open_in_any_editor() {
        val c = File(workspace, "c.py")
        c.writeText("x = 1\n")
        val uri = c.toPath().toUri().toString()
        val result = apply(applier(), params(editOp(uri, range(0, 4, 0, 5), "2")))
        assertTrue(result.toString(), applied(result))
        assertEquals("x = 2\n", c.readText())
    }

    fun test_applyEdit_creates_missing_file_and_parents() {
        val target = File(workspace, "new/deep/dir/n.kt")
        val result = apply(applier(), params(createOp(target.toPath().toUri().toString(), "fun main() {}\n")))
        assertTrue(result.toString(), applied(result))
        assertEquals("fun main() {}\n", target.readText())
        assertNotNull(LocalFileSystem.getInstance().findFileByIoFile(target))

        // A file that already exists is not overwritten.
        val again = apply(applier(), params(createOp(target.toPath().toUri().toString(), "other")))
        assertFalse(applied(again))
        assertTrue(error(again)!!, error(again)!!.contains("already exists"))
        assertEquals("fun main() {}\n", target.readText())

        // Create, then edit the new file, in one request: ops apply in order.
        val m = File(workspace, "m.txt").toPath().toUri().toString()
        val both = apply(applier(), params(createOp(m, "abc"), editOp(m, range(0, 1, 0, 2), "B")))
        assertTrue(both.toString(), applied(both))
        assertEquals("aBc", File(workspace, "m.txt").readText())
    }

    fun test_applyEdit_rejects_paths_outside_workspace() {
        val outside = tempDir("outside")
        val victim = localFile(File(outside, "v.txt"), "keep\n")
        val r1 = apply(applier(), params(editOp(documentUri(victim), range(0, 0, 0, 4), "gone")))
        assertFalse(applied(r1))
        assertTrue(error(r1)!!, error(r1)!!.contains("outside the workspace"))
        assertEquals("keep\n", docOf(victim).text)

        // `..` escapes and creates outside are refused too; nothing is written.
        val dotdot = workspace.toPath().toUri().toString() + "../" + outside.name + "/w.txt"
        val r2 = apply(applier(), params(createOp(dotdot, "x")))
        assertFalse(applied(r2))
        assertTrue(error(r2)!!, error(r2)!!.contains("outside the workspace"))
        assertFalse(File(outside, "w.txt").exists())

        // A symlink inside the workspace that points outside does not let a create through.
        val link = File(workspace, "link").toPath()
        java.nio.file.Files.createSymbolicLink(link, outside.toPath())
        val r3 = apply(applier(), params(createOp(link.resolve("s.txt").toUri().toString(), "x")))
        assertFalse(applied(r3))
        assertFalse(File(outside, "s.txt").exists())

        // The workspace root itself is not a file target.
        val r4 = apply(applier(), params(createOp(workspace.toPath().toUri().toString(), "x")))
        assertFalse(applied(r4))
    }

    fun test_applyEdit_returns_error_not_throw() {
        val a = localFile(File(workspace, "a.txt"), "one\ntwo\n")
        val uri = documentUri(a)
        val cases = listOf(
            buildJsonObject { put("nope", 1) },
            params(buildJsonObject { put("kind", "rename"); put("uri", uri) }),
            params(editOp("not a uri at all", range(0, 0, 0, 0), "x")),
            params(editOp("http://example.com/a.txt", range(0, 0, 0, 0), "x")),
            params(editOp(File(workspace, "missing.txt").toPath().toUri().toString(), range(0, 0, 0, 0), "x")),
            params(editOp(uri, range(7, 0, 7, 0), "x")),
            params(editOp(uri, range(0, 9, 0, 9), "x")),
            params(editOp(uri, range(1, 0, 0, 0), "x")),
            params(editOp("$uri.ipynb.cells.py", range(0, 0, 0, 0), "x")),
            params(editOp(File(workspace, "nb.ipynb").toPath().toUri().toString() + ".cell0.py", range(0, 0, 0, 0), "x")),
            params(createOp(File(workspace, "nb.ipynb").toPath().toUri().toString() + ".cell3.py", "x")),
        )
        for (p in cases) {
            val result = apply(applier(), p)
            assertFalse(p.toString(), applied(result))
            assertFalse(p.toString(), error(result).isNullOrBlank())
        }
        assertEquals("one\ntwo\n", docOf(a).text)
        assertFalse(File(workspace, "nb.ipynb.cell3.py").exists())
        assertFalse(File(workspace, "nb.ipynb.cell0.py").exists())

        // A whole .ipynb opened as the `#%%` text cannot be edited with positions meant for its JSON.
        val nb = localFile(File(workspace, "x.ipynb"), "{\"cells\":[],\"metadata\":{},\"nbformat\":4,\"nbformat_minor\":5}")
        val r = apply(applier(), params(editOp(documentUri(nb), range(0, 0, 0, 0), "x")))
        assertFalse(applied(r))
        assertTrue(error(r)!!, error(r)!!.contains(".cell"))
    }

    fun test_applyEdit_targets_notebook_cell_range() {
        val sink = RecordingSink()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        try {
            val root = Path.of(ModuleRootManager.getInstance(module).contentRoots.single().path)
            val sync = DocumentSyncListener(project, sink, scope, testRootDisposable, root)
            val cells = NotebookCellSync(sink, scope)
            sync.notebookSync = cells
            sync.install()

            val json = """{"cells":[""" +
                """{"cell_type":"code","metadata":{},"source":["import os\n","x = 1"],"outputs":[],"execution_count":null},""" +
                """{"cell_type":"markdown","metadata":{},"source":["# Title"]},""" +
                """{"cell_type":"code","metadata":{},"source":["y = 2"],"outputs":[],"execution_count":null}""" +
                """],"metadata":{"language_info":{"name":"python"}},"nbformat":4,"nbformat_minor":5}"""
            val file = myFixture.configureByText("nb.ipynb", json).virtualFile
            val document = docOf(file)
            assertEquals("#%%\nimport os\nx = 1\n#%% md\n# Title\n#%%\ny = 2", document.text)
            val base = documentUri(file)
            val applier = ApplyEdit(project, workspace.toPath()) { cells.cellForUri(it) }

            // Cell-relative positions land in that cell's range of the `#%%` Document.
            val r1 = apply(applier, params(editOp("$base.cell2.py", range(0, 4, 0, 5), "3"), save = false))
            assertTrue(r1.toString(), applied(r1))
            assertEquals("#%%\nimport os\nx = 1\n#%% md\n# Title\n#%%\ny = 3", document.text)

            // A line starting `#%%` in the new text would split the cell: it is escaped `##%%` as the Jupyter
            // plugin does, including a marker completed from text that was already there.
            val r2 = apply(applier, params(editOp("$base.cell0.py", range(1, 0, 1, 0), "#%% x\n#"), save = true))
            assertTrue(r2.toString(), applied(r2))
            assertEquals("#%%\nimport os\n##%% x\n#x = 1\n#%% md\n# Title\n#%%\ny = 3", document.text)
            val r3 = apply(applier, params(editOp("$base.cell0.py", range(2, 1, 2, 1), "%% "), save = true))
            assertTrue(r3.toString(), applied(r3))
            assertEquals("#%%\nimport os\n##%% x\n##%% x = 1\n#%% md\n# Title\n#%%\ny = 3", document.text)
            assertEquals(3, dev.localpilot.sync.NotebookCells.parse(document.text, "python").size)
            assertNotNull(cells.cellForUri("$base.cell2.py"))
            assertNull(cells.cellForUri("$base.cell3.py"))

            // save: the notebook is written back (as JSON) and no `.cellN` file was created.
            assertFalse(FileDocumentManager.getInstance().isDocumentUnsaved(document))
            val disk = String(file.contentsToByteArray())
            assertTrue(disk, disk.contains("\"cell_type\": \"markdown\""))
            assertTrue(disk, disk.contains("##%% x"))
            assertTrue(disk, disk.contains("y = 3"))
            assertNull(file.parent.findChild("nb.ipynb.cell0.py"))

            // Markdown cells and the concat doc are refused.
            val r4 = apply(applier, params(editOp("$base.cell1.md", range(0, 0, 0, 0), "x")))
            assertFalse(applied(r4))
            val r5 = apply(applier, params(editOp("$base.cells.py", range(0, 0, 0, 0), "x")))
            assertFalse(applied(r5))
            assertTrue(error(r5)!!, error(r5)!!.contains("read-only"))
            // Out-of-range in a cell → error, cell untouched.
            val r6 = apply(applier, params(editOp("$base.cell2.py", range(1, 0, 1, 0), "x")))
            assertFalse(applied(r6))
            assertTrue(document.text.endsWith("#%%\ny = 3"))
        } finally {
            scope.cancel()
        }
    }
}
