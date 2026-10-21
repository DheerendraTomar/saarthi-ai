package dev.localpilot.completion

import com.intellij.codeInsight.inline.completion.InlineCompletionEvent
import com.intellij.codeInsight.inline.completion.InlineCompletionRequest
import com.intellij.codeInsight.inline.completion.suggestion.InlineCompletionSuggestion
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiDocumentManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.localpilot.rpc.CoreState
import dev.localpilot.settings.LocalPilotSettingsState
import dev.localpilot.sync.DocumentSyncListener
import dev.localpilot.sync.NotebookCellSync
import dev.localpilot.sync.documentUri
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.addJsonObject
import java.nio.file.Path

/**
 * A fake core: records notifications and requests, answers `completion/request` with [answer]. Like
 * `CoreProcess.requestJson` (its default `cancelHook`), a cancelled `completion/request` notifies
 * `completion/cancel { requestId }`.
 */
class FakeCompletionClient : CompletionClient {
    override val state = MutableStateFlow(CoreState.READY)
    val notifications = mutableListOf<Pair<String, JsonObject>>()
    val requests = mutableListOf<Pair<String, JsonObject>>()
    /** Completed with the params of the next request that arrives. */
    var requestArrived = CompletableDeferred<JsonObject>()
    var answer: suspend (JsonObject) -> JsonElement = { completionResult("") }

    override fun notify(method: String, params: JsonElement) {
        synchronized(notifications) { notifications.add(method to params.jsonObject) }
    }

    override suspend fun request(method: String, params: JsonElement): JsonElement {
        val p = params.jsonObject
        synchronized(requests) { requests.add(method to p) }
        requestArrived.complete(p)
        try {
            return answer(p)
        } catch (e: kotlinx.coroutines.CancellationException) {
            if (method == "completion/request") notify("completion/cancel", buildJsonObject { put("requestId", p["requestId"]!!) })
            throw e
        }
    }

    /** Non-sync notifications (completion outcomes and cancels), in order. */
    fun outcomes(): List<Pair<String, JsonObject>> =
        synchronized(notifications) { notifications.filter { it.first.startsWith("completion/") } }

    companion object {
        fun completionResult(text: String, line: Int = 0, character: Int = 0) = buildJsonObject {
            putJsonArray("items") {
                if (text.isNotEmpty()) addJsonObject {
                    put("text", text)
                    putJsonObject("range") {
                        putJsonObject("start") { put("line", line); put("character", character) }
                        putJsonObject("end") { put("line", line); put("character", character) }
                    }
                }
            }
        }
    }
}

/**
 * The inline provider against a light project with real document / notebook sync and a [FakeCompletionClient].
 * JUnit 3 `test_` prefix (BasePlatformTestCase); the rest of each name is the plan's test name.
 */
class InlineProviderTest : BasePlatformTestCase() {
    private lateinit var client: FakeCompletionClient
    private lateinit var scope: CoroutineScope
    private lateinit var sync: DocumentSyncListener
    private lateinit var cells: NotebookCellSync
    private lateinit var provider: LocalPilotInlineCompletionProvider
    private var settings = LocalPilotSettingsState(completionDebounceMs = 0)

    override fun setUp() {
        super.setUp()
        client = FakeCompletionClient()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val workspace = Path.of(ModuleRootManager.getInstance(module).contentRoots.single().path)
        sync = DocumentSyncListener(project, client, scope, testRootDisposable, workspace)
        cells = NotebookCellSync(client, scope)
        sync.notebookSync = cells
        sync.install()
        provider = LocalPilotInlineCompletionProvider { CompletionDeps(client, sync, cells) { settings } }
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

    private fun docOf(file: VirtualFile): Document = FileDocumentManager.getInstance().getDocument(file)!!

    /** A direct-call request at [offset] (the platform builds these itself; the test needs one without the handler). */
    @Suppress("DEPRECATION")
    private fun directCall(offset: Int = myFixture.editor.caretModel.offset): InlineCompletionRequest {
        val editor = myFixture.editor
        val event = InlineCompletionEvent.DirectCall(editor, editor.caretModel.currentCaret, DataContext.EMPTY_CONTEXT)
        val psi = PsiDocumentManager.getInstance(project).getPsiFile(editor.document)!!
        return InlineCompletionRequest(event, psi, editor, editor.document, offset, offset, null)
    }

    private suspend fun textOf(suggestion: InlineCompletionSuggestion): String =
        suggestion.getVariants().singleOrNull()?.elements?.toList()?.joinToString("") { it.text } ?: ""

    private fun suggest(request: InlineCompletionRequest = directCall()): String = runBlocking {
        withTimeout(10_000) { textOf(provider.getSuggestion(request)) }
    }

    fun test_provider_requests_completion_for_caret_and_returns_text() {
        val file = myFixture.configureByText("a.py", "def f():\n    ret<caret>\n").virtualFile
        client.answer = { FakeCompletionClient.completionResult("urn 1", 1, 7) }
        assertTrue(provider.isEnabled(directCall().event))

        assertEquals("urn 1", suggest())

        val (method, params) = client.requests.single()
        assertEquals("completion/request", method)
        assertEquals(documentUri(file), params["uri"]!!.jsonPrimitive.content)
        val position = params["position"]!!.jsonObject
        assertEquals(1 to 7, position["line"]!!.jsonPrimitive.int to position["character"]!!.jsonPrimitive.int)
        assertTrue(params["requestId"]!!.jsonPrimitive.content.isNotEmpty())
        assertEquals(LocalPilotInlineCompletionProvider.ID, provider.id)
        assertEquals(emptyList<Any>(), client.outcomes())

        // An empty answer is a valid "no suggestion".
        client.answer = { FakeCompletionClient.completionResult("") }
        assertEquals("", suggest())
        // So is a core that is not running.
        client.answer = { throw IllegalStateException("not running") }
        assertEquals("", suggest())
    }

    fun test_provider_cancels_on_coroutine_cancel() {
        myFixture.configureByText("a.py", "x = <caret>\n")
        client.answer = { awaitCancellation() }
        val request = directCall()
        runBlocking {
            val job = async(Dispatchers.Default) { provider.getSuggestion(request) }
            val params = withTimeout(10_000) { client.requestArrived.await() }
            job.cancel()
            runCatching { job.await() }
            assertTrue(job.isCancelled)
            val requestId = params["requestId"]!!.jsonPrimitive.content
            assertEquals(listOf("completion/cancel" to requestId), client.outcomes().map { it.first to it.second["requestId"]!!.jsonPrimitive.content })
        }
    }

    fun test_provider_disabled_returns_nothing() {
        myFixture.configureByText("a.py", "x = <caret>\n")
        client.answer = { FakeCompletionClient.completionResult("1") }

        settings = LocalPilotSettingsState(completionDebounceMs = 0, completionsEnabled = false)
        assertFalse(provider.isEnabled(directCall().event))
        assertEquals("", suggest())

        settings = LocalPilotSettingsState(completionDebounceMs = 0)
        client.state.value = CoreState.STARTING
        assertFalse(provider.isEnabled(directCall().event))
        client.state.value = CoreState.READY
        assertTrue(provider.isEnabled(directCall().event))

        // Not synced (outside the project): no completions.
        myFixture.configureByText("b.txt", "")
        val light = com.intellij.testFramework.LightVirtualFile("c.py", "y = ")
        myFixture.openFileInEditor(light)
        assertFalse(provider.isEnabled(directCall().event))
        assertEquals("", suggest())
        assertEquals(emptyList<Any>(), client.requests)
    }

    fun test_provider_in_notebook_uses_cell_uri() {
        val json = """{"cells":[""" +
            """{"cell_type":"code","metadata":{},"source":["import os\n","x = 1"],"outputs":[],"execution_count":null},""" +
            """{"cell_type":"markdown","metadata":{},"source":["# Title"]},""" +
            """{"cell_type":"code","metadata":{},"source":["y = 2"],"outputs":[],"execution_count":null}],""" +
            """"metadata":{"kernelspec":{"display_name":"K","language":"python","name":"k"},"language_info":{"name":"python"}},""" +
            """"nbformat":4,"nbformat_minor":5}"""
        val file = myFixture.configureByText("nb.ipynb", json).virtualFile
        val document = docOf(file)
        assertEquals("#%%\nimport os\nx = 1\n#%% md\n# Title\n#%%\ny = 2", document.text)
        client.answer = { FakeCompletionClient.completionResult("3") }

        val inCell = document.text.indexOf("y = 2") + 5
        myFixture.editor.caretModel.moveToOffset(inCell)
        assertTrue(provider.isEnabled(directCall().event))
        assertEquals("3", suggest())
        val params = client.requests.single().second
        assertEquals("${documentUri(file)}.cell2.py", params["uri"]!!.jsonPrimitive.content)
        val position = params["position"]!!.jsonObject
        assertEquals(0 to 5, position["line"]!!.jsonPrimitive.int to position["character"]!!.jsonPrimitive.int)

        // Markdown cell: nothing.
        myFixture.editor.caretModel.moveToOffset(document.text.indexOf("Title"))
        assertFalse(provider.isEnabled(directCall().event))
        assertEquals("", suggest())
        assertEquals(1, client.requests.size)
    }
}
