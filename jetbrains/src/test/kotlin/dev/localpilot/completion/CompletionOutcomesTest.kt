package dev.localpilot.completion

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class CompletionOutcomesTest {
    private fun describe(run: SuggestionRun): String {
        val (method, p) = run.outcome()
        assertEquals(run.requestId, p["requestId"]!!.jsonPrimitive.content)
        return listOfNotNull(method, p["outcome"]?.jsonPrimitive?.content, p["acceptedText"]?.jsonPrimitive?.content).joinToString(" ")
    }

    @Test
    fun untouched_is_rejected() {
        assertEquals("completion/rejected", describe(SuggestionRun("1", "foo(bar)")))
    }

    @Test
    fun typed_part_by_hand_is_rejected() {
        val run = SuggestionRun("1", "foo(bar)")
        run.update("o(bar)", partialAccept = false)
        assertEquals("completion/rejected", describe(run))
    }

    @Test
    fun typed_whole_is_typed_through_ignoring_trailing_whitespace() {
        val run = SuggestionRun("1", "abc\n")
        run.update("bc\n", partialAccept = false)
        run.update("\n", partialAccept = false)
        assertEquals("completion/outcome typedThrough", describe(run))
    }

    @Test
    fun partial_accept_then_stop_is_partial_with_taken_text() {
        val run = SuggestionRun("7", "foo bar baz")
        run.update(" bar baz", partialAccept = true)
        run.update("bar baz", partialAccept = false) // then a typed space
        assertEquals("completion/outcome partial foo ", describe(run))
    }

    @Test
    fun partial_accepts_through_the_whole_is_accepted() {
        val run = SuggestionRun("7", "foo bar")
        run.update(" bar", partialAccept = true)
        run.update("", partialAccept = true)
        assertEquals("completion/outcome accepted foo bar", describe(run))
    }

    @Test
    fun reporter_sends_each_request_once() {
        val sent = mutableListOf<Pair<String, JsonElement>>()
        val reporter = OutcomeReporter()
        val notify: (String, JsonElement) -> Unit = { m, p -> sent += m to p }
        reporter.accepted("1", notify)
        reporter.finished(SuggestionRun("1", "x"), notify)
        reporter.finished(SuggestionRun("2", "x"), notify)
        reporter.accepted("2", notify)
        assertEquals(
            listOf("completion/accepted 1", "completion/rejected 2"),
            sent.map { (m, p) -> "$m ${p.jsonObject["requestId"]!!.jsonPrimitive.content}" },
        )
    }
}
