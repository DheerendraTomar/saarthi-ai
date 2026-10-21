package dev.localpilot.sync

import com.intellij.ide.scratch.ScratchRootType
import com.intellij.lang.Language
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.PsiTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.DocumentUtil
import dev.localpilot.rpc.CoreState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.nio.file.Path

/** Records what the sync would send to the core; `state` simulates core restarts. */
class RecordingSink(initial: CoreState = CoreState.READY) : DocumentSink {
    val calls = mutableListOf<Pair<String, JsonObject>>()
    override val state = MutableStateFlow(initial)
    override fun notify(method: String, params: JsonElement) {
        synchronized(calls) { calls.add(method to params.jsonObject) }
    }
    fun take(): List<Pair<String, JsonObject>> = synchronized(calls) { calls.toList().also { calls.clear() } }
}

/**
 * Document sync against a light project (content root `temp:///src`). Methods use the JUnit 3 `test` prefix
 * (BasePlatformTestCase is a JUnit 3 TestCase run by the JUnit 4 runner); the rest of the name is the plan's test name.
 */
class DocumentSyncTest : BasePlatformTestCase() {
    private lateinit var sink: RecordingSink
    private lateinit var scope: CoroutineScope
    private lateinit var sync: DocumentSyncListener
    /** The light project's content root (`temp:///src` → `/src`) stands in for the project base path. */
    private lateinit var workspace: Path
    private val tempDirs = mutableListOf<File>()

    override fun setUp() {
        super.setUp()
        sink = RecordingSink()
        // Unconfined: every `state.value = …` runs the collector synchronously, so no transition is conflated away.
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        workspace = Path.of(ModuleRootManager.getInstance(module).contentRoots.single().path)
        sync = DocumentSyncListener(project, sink, scope, testRootDisposable, workspace)
        sync.install()
        sink.take()
    }

    override fun tearDown() {
        try {
            scope.cancel()
            for (dir in tempDirs) FileUtil.delete(dir)
        } catch (e: Throwable) {
            addSuppressedException(e)
        } finally {
            super.tearDown()
        }
    }

    private fun tempDir(prefix: String): File = FileUtil.createTempDirectory(prefix, null).also { tempDirs += it }

    private fun edit(document: Document, block: Document.() -> Unit) =
        WriteCommandAction.runWriteCommandAction(project) { document.block() }

    /** Replay serialises each document in its own (suspending) read action: wait for [count] calls to arrive. */
    private fun awaitCalls(count: Int): List<Pair<String, JsonObject>> {
        PlatformTestUtil.waitWithEventsDispatching(
            "expected $count calls",
            { synchronized(sink.calls) { sink.calls.size >= count } },
            10,
        )
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        return sink.take()
    }

    private fun docOf(file: VirtualFile): Document = FileDocumentManager.getInstance().getDocument(file)!!

    private fun pos(line: Int, character: Int) = "{\"line\":$line,\"character\":$character}"

    private fun range(change: JsonElement): String {
        val r = change.jsonObject["range"]!!.jsonObject
        return "${r["start"]}-${r["end"]}"
    }

    fun test_opens_and_changes_content_file() {
        val file = myFixture.configureByText("a.py", "x = 1\n").virtualFile
        val uri = documentUri(file)
        assertTrue(uri, uri.startsWith("file:///"))
        assertTrue(uri, uri.endsWith("/a.py"))

        val opened = sink.take()
        assertEquals(1, opened.size)
        val (method, params) = opened.single()
        assertEquals("textDocument/didOpen", method)
        assertEquals(uri, params["uri"]!!.jsonPrimitive.content)
        assertEquals("python", params["languageId"]!!.jsonPrimitive.content)
        assertEquals(1, params["version"]!!.jsonPrimitive.int)
        assertEquals("x = 1\n", params["text"]!!.jsonPrimitive.content)
        assertEquals(1, sync.versionOf(file))

        val document = docOf(file)
        edit(document) { insertString(5, "y") } // "x = 1y\n"
        edit(document) { replaceString(4, 7, "2\nz") } // "x = 2\nz"
        val changes = sink.take()
        assertEquals(listOf("textDocument/didChange", "textDocument/didChange"), changes.map { it.first })
        val first = changes[0].second
        assertEquals(uri, first["uri"]!!.jsonPrimitive.content)
        assertEquals(2, first["version"]!!.jsonPrimitive.int)
        val c1 = first["contentChanges"]!!.jsonArray.single()
        assertEquals("${pos(0, 5)}-${pos(0, 5)}", range(c1))
        assertEquals("y", c1.jsonObject["text"]!!.jsonPrimitive.content)
        val second = changes[1].second
        assertEquals(3, second["version"]!!.jsonPrimitive.int)
        val c2 = second["contentChanges"]!!.jsonArray.single()
        assertEquals("${pos(0, 4)}-${pos(1, 0)}", range(c2))
        assertEquals("2\nz", c2.jsonObject["text"]!!.jsonPrimitive.content)

        FileEditorManager.getInstance(project).closeFile(file)
        val closed = sink.take()
        assertEquals(listOf("textDocument/didClose"), closed.map { it.first })
        assertEquals(uri, closed.single().second["uri"]!!.jsonPrimitive.content)
        assertNull(sync.versionOf(file))

        edit(document) { insertString(0, "#") }
        assertEquals(emptyList<Pair<String, JsonObject>>(), sink.take())
    }

    fun test_ignores_scratch_and_library_files() {
        // Scratch file (Review Focus 2).
        val scratch = ScratchRootType.getInstance()
            .createScratchFile(project, "scratch.py", Language.ANY, "s = 1\n")!!
        myFixture.openFileInEditor(scratch)
        edit(docOf(scratch)) { insertString(0, "#") }

        // Library sources inside the content root: in content, but also in a library.
        val libFile = myFixture.addFileToProject("libsrc/libmod.py", "def f(): pass\n").virtualFile
        val lib = PsiTestUtil.addProjectLibrary(module, "testlib", emptyList(), listOf(libFile.parent))
        try {
            myFixture.openFileInEditor(libFile)
            edit(docOf(libFile)) { insertString(0, "#") }
        } finally {
            PsiTestUtil.removeLibrary(module, lib)
        }

        // A real local file outside the project (the content root is temp:///src).
        val outsideIo = tempDir("localpilot-outside").resolve("o.py").apply { writeText("o = 1\n") }
        val outside = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(outsideIo.toPath())!!
        myFixture.openFileInEditor(outside)
        edit(docOf(outside)) { insertString(0, "#") }

        // An in-memory file.
        val light = LightVirtualFile("light.py", "l = 1\n")
        myFixture.openFileInEditor(light)
        edit(docOf(light)) { insertString(0, "#") }

        // Notebooks are routed elsewhere (Task 4): never synced as plain files.
        val nb = myFixture.addFileToProject("nb.ipynb", "{\"cells\": []}\n").virtualFile
        myFixture.openFileInEditor(nb)

        assertFalse(isSyncableFile(project, scratch, workspace))
        assertFalse(isSyncableFile(project, light, workspace))
        assertFalse(isSyncableFile(project, outside, workspace))
        assertTrue(isNotebookFile(nb))
        assertEquals(emptyList<Pair<String, JsonObject>>(), sink.take())

        // Sanity: a plain content file next to them is synced.
        myFixture.configureByText("ok.py", "ok = 1\n")
        assertEquals(listOf("textDocument/didOpen"), sink.take().map { it.first })
    }

    fun test_offsets_map_to_utf16_positions_with_emoji() {
        // "a😀b": the emoji is a surrogate pair, 2 UTF-16 units → 'b' is at character 3.
        val file = myFixture.configureByText("e.py", "a😀b\nc😀d").virtualFile
        sink.take()
        val document = docOf(file)
        edit(document) { insertString(3, "X") } // "a😀Xb\nc😀d"
        edit(document) { deleteString(7, 9) } // line 1 starts at 6: "c😀d" → delete the emoji (units 1..3)
        edit(document) { replaceString(1, 7, "") } // "a" + "d": from {0,1} across the newline to {1,1}
        val changes = sink.take().map { it.second["contentChanges"]!!.jsonArray.single() }
        assertEquals(3, changes.size)
        assertEquals("${pos(0, 3)}-${pos(0, 3)}", range(changes[0]))
        assertEquals("X", changes[0].jsonObject["text"]!!.jsonPrimitive.content)
        assertEquals("${pos(1, 1)}-${pos(1, 3)}", range(changes[1]))
        assertEquals("", changes[1].jsonObject["text"]!!.jsonPrimitive.content)
        assertEquals("${pos(0, 1)}-${pos(1, 1)}", range(changes[2]))
        assertEquals("ad", document.text)
    }

    fun test_save_sends_didSave() {
        val file = myFixture.configureByText("s.py", "a = 1\n").virtualFile
        sink.take()
        val document = docOf(file)
        edit(document) { insertString(0, "#") }
        FileDocumentManager.getInstance().saveDocument(document)
        val calls = sink.take()
        assertEquals(listOf("textDocument/didChange", "textDocument/didSave"), calls.map { it.first })
        assertEquals(documentUri(file), calls[1].second["uri"]!!.jsonPrimitive.content)
    }

    fun test_replay_after_restart() {
        val a = myFixture.configureByText("ra.py", "a = 1\n").virtualFile
        val b = myFixture.configureByText("rb.kt", "val b = 1\n").virtualFile
        val c = myFixture.configureByText("rc.py", "c = 1\n").virtualFile
        edit(docOf(a)) { insertString(0, "#") } // a → version 2
        FileEditorManager.getInstance(project).closeFile(c)
        sink.take()

        sink.state.value = CoreState.CRASHED
        sink.state.value = CoreState.STARTING
        assertEquals(emptyList<Pair<String, JsonObject>>(), sink.take())
        sink.state.value = CoreState.READY
        val replay = awaitCalls(2)
        assertEquals(listOf("textDocument/didOpen", "textDocument/didOpen"), replay.map { it.first })
        val byUri = replay.associate { it.second["uri"]!!.jsonPrimitive.content to it.second }
        val ra = byUri.getValue(documentUri(a))
        assertEquals(2, ra["version"]!!.jsonPrimitive.int)
        assertEquals("#a = 1\n", ra["text"]!!.jsonPrimitive.content)
        assertEquals("python", ra["languageId"]!!.jsonPrimitive.content)
        val rb = byUri.getValue(documentUri(b))
        assertEquals(1, rb["version"]!!.jsonPrimitive.int)
        assertEquals("kotlin", rb["languageId"]!!.jsonPrimitive.content)

        // Versions keep increasing across the restart.
        edit(docOf(a)) { insertString(0, "#") }
        assertEquals(3, sink.take().single().second["version"]!!.jsonPrimitive.int)

        // A second restart replays again.
        sink.state.value = CoreState.STARTING
        sink.state.value = CoreState.READY
        assertEquals(2, awaitCalls(2).size)
    }

    fun test_bulk_update_sends_whole_text() {
        val file = myFixture.configureByText("bulk.py", "a\nb\n").virtualFile
        sink.take()
        val document = docOf(file)
        edit(document) {
            DocumentUtil.executeInBulk(this) {
                insertString(0, "1")
                insertString(2, "2")
            }
        }
        val calls = sink.take()
        assertEquals(listOf("textDocument/didChange"), calls.map { it.first })
        val change = calls.single().second["contentChanges"]!!.jsonArray.single().jsonObject
        assertNull(change["range"])
        assertEquals(document.text, change["text"]!!.jsonPrimitive.content)
        assertEquals(2, calls.single().second["version"]!!.jsonPrimitive.int)
    }

    fun test_size_cap_closes_and_reopens() {
        val big = "x".repeat(MAX_SYNC_CHARS + 1)
        val file = myFixture.configureByText("big.txt", big).virtualFile
        assertEquals(emptyList<Pair<String, JsonObject>>(), sink.take())
        val document = docOf(file)
        edit(document) { deleteString(0, 2) } // shrinks under the cap → opens
        val opened = sink.take()
        assertEquals(listOf("textDocument/didOpen"), opened.map { it.first })
        assertEquals("plaintext", opened.single().second["languageId"]!!.jsonPrimitive.content)
        edit(document) { insertString(0, "yy") } // grows past it → closes
        assertEquals(listOf("textDocument/didClose"), sink.take().map { it.first })
    }

    fun test_language_ids() {
        fun id(name: String) = languageIdOf(LightVirtualFile(name, ""))
        assertEquals("python", id("a.py"))
        assertEquals("kotlin", id("a.kts"))
        assertEquals("java", id("A.java"))
        assertEquals("typescript", id("a.ts"))
        assertEquals("javascript", id("a.mjs"))
        assertEquals("rust", id("a.rs"))
        assertEquals("go", id("a.go"))
        assertEquals("markdown", id("README.md"))
        assertEquals("json", id("a.json"))
        assertEquals("yaml", id("a.yml"))
        assertEquals("shellscript", id("a.sh"))
        assertEquals("plaintext", id("notes.txt"))
        assertEquals("zig", id("a.ZIG"))
    }

    fun test_rename_closes_old_uri_and_opens_new() {
        val file = myFixture.configureByText("old.py", "x = 1\n").virtualFile
        val oldUri = documentUri(file)
        val document = docOf(file)
        edit(document) { insertString(0, "#") } // version 2
        sink.take()

        WriteCommandAction.runWriteCommandAction(project) { file.rename(this, "new.kt") }
        val newUri = documentUri(file)
        assertTrue(newUri, newUri.endsWith("/new.kt"))
        val calls = sink.take()
        assertEquals(listOf("textDocument/didClose", "textDocument/didOpen"), calls.map { it.first })
        assertEquals(oldUri, calls[0].second["uri"]!!.jsonPrimitive.content)
        val open = calls[1].second
        assertEquals(newUri, open["uri"]!!.jsonPrimitive.content)
        assertEquals("kotlin", open["languageId"]!!.jsonPrimitive.content)
        // A new uri is a new document in the core: its version restarts at 1.
        assertEquals(1, open["version"]!!.jsonPrimitive.int)
        assertEquals("#x = 1\n", open["text"]!!.jsonPrimitive.content)
        assertEquals(1, sync.versionOf(file))

        edit(document) { insertString(0, "#") }
        val change = sink.take().single()
        assertEquals("textDocument/didChange", change.first)
        assertEquals(newUri, change.second["uri"]!!.jsonPrimitive.content)
        assertEquals(2, change.second["version"]!!.jsonPrimitive.int)

        // Renaming its parent directory moves the uri too.
        val dirFile = myFixture.addFileToProject("pkg/d.py", "d = 1\n").virtualFile
        myFixture.openFileInEditor(dirFile)
        val dirOldUri = documentUri(dirFile)
        sink.take()
        WriteCommandAction.runWriteCommandAction(project) { dirFile.parent.rename(this, "pkg2") }
        val dirCalls = sink.take()
        assertEquals(listOf("textDocument/didClose", "textDocument/didOpen"), dirCalls.map { it.first })
        assertEquals(dirOldUri, dirCalls[0].second["uri"]!!.jsonPrimitive.content)
        assertTrue(dirCalls[1].second["uri"]!!.jsonPrimitive.content.endsWith("/pkg2/d.py"))
    }

    fun test_move_out_of_content_closes() {
        val file = myFixture.configureByText("m.py", "m = 1\n").virtualFile
        val oldUri = documentUri(file)
        sink.take()
        val srcRoot = file.parent
        val outside = WriteCommandAction.runWriteCommandAction<VirtualFile>(project) {
            VfsUtil.createDirectoryIfMissing(srcRoot.parent, "localpilot-outside-content")
        }
        try {
            WriteCommandAction.runWriteCommandAction(project) { file.move(this, outside) }
            assertTrue(FileEditorManager.getInstance(project).isFileOpen(file))
            val calls = sink.take()
            assertEquals(listOf("textDocument/didClose"), calls.map { it.first })
            assertEquals(oldUri, calls.single().second["uri"]!!.jsonPrimitive.content)
            assertNull(sync.versionOf(file))
            edit(docOf(file)) { insertString(0, "#") }
            assertEquals(emptyList<Pair<String, JsonObject>>(), sink.take())
        } finally {
            FileEditorManager.getInstance(project).closeFile(file)
            WriteCommandAction.runWriteCommandAction(project) { outside.delete(this) }
        }
    }

    fun test_content_root_outside_workspace_is_not_synced() {
        val dir = tempDir("localpilot-extra-root")
        File(dir, "extra.py").writeText("e = 1\n")
        val root = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(dir.toPath())!!
        PsiTestUtil.addContentRoot(module, root)
        try {
            val file = root.findChild("extra.py")!!
            assertTrue(ProjectFileIndex.getInstance(project).isInContent(file))
            assertFalse(isSyncableFile(project, file, workspace))
            myFixture.openFileInEditor(file)
            edit(docOf(file)) { insertString(0, "#") }
            assertNull(sync.versionOf(file))
            assertEquals(emptyList<Pair<String, JsonObject>>(), sink.take())
            FileEditorManager.getInstance(project).closeFile(file)
        } finally {
            PsiTestUtil.removeContentEntry(module, root)
        }
    }

    fun test_setting_notebook_sync_opens_already_open_notebooks() {
        val nb = myFixture.addFileToProject("open.ipynb", "{\"cells\": []}\n").virtualFile
        myFixture.openFileInEditor(nb)
        val opened = mutableListOf<VirtualFile>()
        sync.notebookSync = object : NotebookSync {
            override fun opened(file: VirtualFile, document: Document) { opened += file }
            override fun changed(file: VirtualFile, event: DocumentEvent) = Unit
            override fun saved(file: VirtualFile) = Unit
            override fun closed(file: VirtualFile) = Unit
            override fun replay() = Unit
        }
        assertEquals(listOf(nb), opened)
        assertEquals(emptyList<Pair<String, JsonObject>>(), sink.take())
    }
}
