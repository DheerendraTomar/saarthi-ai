package dev.localpilot.actions

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelsTest {
    private val models = Models.parse(
        Json.parseToJsonElement(
            """{"models":[
                {"name":"qwen2.5-coder:0.5b-base","sizeBytes":986000000,"family":"qwen2","supportsInsert":true,"supportsTools":false},
                {"name":"llama3.2:3b","sizeBytes":17000000000,"supportsInsert":false,"supportsTools":true},
                {"name":""}, 42, {"sizeBytes":1}
            ]}""",
        ),
    )

    @Test
    fun parses_models_and_skips_malformed() {
        assertEquals(listOf("qwen2.5-coder:0.5b-base", "llama3.2:3b"), models.map { it.name })
        assertEquals("qwen2", models[0].family)
        assertNull(models[1].family)
        assertEquals(emptyList<ModelInfo>(), Models.parse(Json.parseToJsonElement("{}")))
    }

    @Test
    fun completion_choices_hint_missing_fill_in_the_middle() {
        val choices = Models.choices(models, ModelKind.COMPLETION, "llama3.2:3b")
        assertEquals("fill-in-the-middle", choices[0].hint)
        assertFalse(choices[0].warning)
        assertEquals("986 MB · qwen2", choices[0].description)
        assertTrue(choices[1].current)
        assertTrue(choices[1].warning)
        assertTrue(choices[1].text, choices[1].text.contains("no fill-in-the-middle"))
        assertEquals("17.0 GB", choices[1].description)
    }

    @Test
    fun chat_choices_hint_missing_tools() {
        val choices = Models.choices(models, ModelKind.CHAT, "none")
        assertTrue(choices[0].warning)
        assertTrue(choices[0].hint.startsWith("no tool calling"))
        assertEquals("tool calling", choices[1].hint)
        assertTrue(choices.none { it.current })
    }

    @Test
    fun stats_parse_and_rows() {
        val stats = CompletionStats.parse(
            Json.parseToJsonElement(
                """{"languages":{"python":{"served":10,"accepted":4,"partial":1,"rejected":3,"typedThrough":2,"acceptRate":0.5,
                   "learnedMaxLines":3,"learnedNumPredict":48,"learned":true,"examples":2}},"logPath":"/tmp/x.jsonl","adaptive":true}""",
            ),
        )
        assertEquals("/tmp/x.jsonl", stats.logPath)
        val row = CompletionStatsDialog.rows(stats).single().toList()
        assertEquals(listOf<Any>("python", 10L, "50%", 4L, 1L, 2L, 3L, "learned: 3 lines, 48 tokens", 2L), row)
        val off = CompletionStats.parse(Json.parseToJsonElement("""{"languages":{},"logPath":null,"adaptive":false}"""))
        assertEquals(emptyList<LanguageStats>(), off.languages)
        assertNull(off.logPath)
    }
}
