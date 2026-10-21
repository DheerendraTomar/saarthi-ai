package dev.localpilot.completion

import com.intellij.codeInsight.inline.completion.InlineCompletion
import com.intellij.codeInsight.inline.completion.InlineCompletionEvent
import com.intellij.codeInsight.inline.completion.InlineCompletionHandler
import com.intellij.codeInsight.inline.completion.InlineCompletionLifecycleTestDSL
import com.intellij.codeInsight.inline.completion.testInlineCompletion
import com.intellij.openapi.application.EDT
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.testFramework.runInEdtAndWait
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.localpilot.settings.LocalPilotSettingsState
import dev.localpilot.sync.DocumentSyncListener
import dev.localpilot.sync.NotebookCellSync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Path

/**
 * Outcome reporting through the platform's real inline-completion session (the `testInlineCompletion` DSL, which
 * needs the test body off the EDT): Tab, Escape, typing through and Insert Next Word.
 */
class InlineProviderOutcomeTest : BasePlatformTestCase() {
    private lateinit var client: FakeCompletionClient
    private lateinit var scope: CoroutineScope
    private lateinit var provider: LocalPilotInlineCompletionProvider

    override fun runInDispatchThread(): Boolean = false

    override fun setUp() {
        super.setUp()
        client = FakeCompletionClient()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        runInEdtAndWait {
            val workspace = Path.of(ModuleRootManager.getInstance(module).contentRoots.single().path)
            val sync = DocumentSyncListener(project, client, scope, testRootDisposable, workspace)
            val cells = NotebookCellSync(client, scope)
            sync.notebookSync = cells
            sync.install()
            val settings = LocalPilotSettingsState(completionDebounceMs = 0)
            provider = LocalPilotInlineCompletionProvider { CompletionDeps(client, sync, cells) { settings } }
            InlineCompletionHandler.registerTestHandler(provider, testRootDisposable)
        }
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

    /** Opens a fresh file with the caret at its end and shows [suggestion] there. */
    private suspend fun InlineCompletionLifecycleTestDSL.show(name: String, text: String, suggestion: String) {
        client.answer = { FakeCompletionClient.completionResult(suggestion) }
        withContext(Dispatchers.EDT) {
            fixture.configureByText(name, "$text<caret>\n")
        }
        callInlineCompletion()
        delay()
        assertInlineRender(suggestion)
    }

    private fun lastRequestId(): String = client.requests.last().second["requestId"]!!.jsonPrimitive.content

    /** The completion notifications since the last call, as `method outcome? acceptedText?` strings (all for the last request). */
    private fun takeOutcomes(): List<String> {
        val out = client.outcomes().map { (method, p) ->
            assertEquals(lastRequestId(), p["requestId"]!!.jsonPrimitive.content)
            listOfNotNull(method, p["outcome"]?.jsonPrimitive?.content, p["acceptedText"]?.jsonPrimitive?.content).joinToString(" ")
        }
        synchronized(client.notifications) { client.notifications.clear() }
        return out
    }

    private suspend fun InlineCompletionLifecycleTestDSL.insertNextWord() {
        withContext(Dispatchers.EDT) {
            val editor = fixture.editor
            // As the Insert Next Word action does: inside a write command.
            WriteCommandAction.runWriteCommandAction(project) {
                InlineCompletion.getHandlerOrNull(editor)!!.invokeEvent(InlineCompletionEvent.InsertNextWord(editor))
            }
        }
        delay()
    }

    fun test_provider_reports_outcome_accepted_and_rejected() {
        myFixture.testInlineCompletion {
            show("a.py", "x = ", "compute(1)")
            insert()
            delay()
            assertFileContent("x = compute(1)<caret>\n")
            assertEquals(listOf("completion/accepted"), takeOutcomes())

            show("b.py", "y = ", "compute(2)")
            escape()
            delay()
            assertEquals(listOf("completion/rejected"), takeOutcomes())

            // Typing something else ends the session: rejected; the next suggestion in the same editor is followed too.
            show("c.py", "u = ", "compute(3)")
            val first = lastRequestId()
            client.answer = { FakeCompletionClient.completionResult("pute(4)") }
            typeChar('x')
            delay()
            val second = lastRequestId()
            assertTrue(first != second)
            assertEquals(listOf("completion/rejected" to first), client.outcomes().map { it.first to it.second["requestId"]!!.jsonPrimitive.content })
            synchronized(client.notifications) { client.notifications.clear() }
            assertInlineRender("pute(4)")
            insert()
            delay()
            assertEquals(listOf("completion/accepted"), takeOutcomes())

            // And a partial accept, again in the same editor.
            client.answer = { FakeCompletionClient.completionResult("foo bar") }
            typeChar(' ')
            delay()
            assertInlineRender("foo bar")
            insertNextWord()
            escape()
            delay()
            assertEquals(listOf("completion/outcome partial foo"), takeOutcomes())
        }
    }

    fun test_typing_through_and_partial_accepts() {
        myFixture.testInlineCompletion {
            show("c.py", "z = ", "abc")
            typeChar('a')
            typeChar('b')
            typeChar('c')
            delay()
            assertEquals(listOf("completion/outcome typedThrough"), takeOutcomes())

            show("d.py", "w = ", "foo bar baz")
            insertNextWord()
            escape()
            delay()
            assertEquals(listOf("completion/outcome partial foo"), takeOutcomes())

            // Partly by hand only: rejected.
            show("e.py", "v = ", "ab")
            typeChar('a')
            escape()
            delay()
            assertEquals(listOf("completion/rejected"), takeOutcomes())

            // A partial accept, then Tab for the rest: accepted once.
            show("f.py", "t = ", "foo bar")
            insertNextWord()
            insert()
            delay()
            assertFileContent("t = foo bar<caret>\n")
            assertEquals(listOf("completion/accepted"), takeOutcomes())
        }
    }
}
