package dev.localpilot.rpc

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList

/** Drives [CoreProcess] against the real fake core child process (`node vscode/test/fakeCore.mjs`). */
class CoreProcessTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val cores = mutableListOf<CoreProcess>()
    private val workspace: Path = Files.createTempDirectory("localpilot-core-test")

    private class Harness(val core: CoreProcess, val logs: CopyOnWriteArrayList<Pair<CoreLogLevel, String>>, val states: CopyOnWriteArrayList<CoreState>) {
        fun count(message: String) = logs.count { it.second == message }
        suspend fun waitForLog(message: String, n: Int = 1) {
            while (count(message) < n) delay(10)
        }
        suspend fun waitForState(state: CoreState) {
            core.state.first { it == state }
        }
    }

    private fun makeCore(env: Map<String, String> = emptyMap(), shutdownTimeoutMs: Long = 2000): Harness {
        val logs = CopyOnWriteArrayList<Pair<CoreLogLevel, String>>()
        val states = CopyOnWriteArrayList<CoreState>()
        val core = CoreProcess(
            scope = scope,
            workspace = workspace,
            command = { CoreCommand(listOf(node, fakeCore), env) },
            initSettings = { buildJsonObject { put("completionsEnabled", true) } },
            logLevel = { "info" },
            log = { level, message -> logs.add(level to message) },
            shutdownTimeoutMs = shutdownTimeoutMs,
        )
        scope.launch(Dispatchers.Default) { core.state.collect { states.add(it) } }
        cores.add(core)
        return Harness(core, logs, states)
    }

    private fun test(block: suspend () -> Unit) = runBlocking { withTimeout(30_000) { block() } }

    @After
    fun tearDown() {
        runBlocking { withTimeout(10_000) { cores.forEach { it.stop() } } }
        scope.cancel()
        workspace.toFile().deleteRecursively()
    }

    private fun completionParams(requestId: String, line: Int = 0, character: Int = 0) = buildJsonObject {
        put("uri", "file:///a.py")
        putJsonObject("position") { put("line", line); put("character", character) }
        put("requestId", requestId)
    }

    @Test
    fun start_sends_initialize_and_returns_result() = test {
        val h = makeCore()
        val indexReady = CompletableDeferred<JsonElement>()
        h.core.onNotification("index/ready") { indexReady.complete(it) }
        assertEquals(CoreState.STOPPED, h.core.state.value)

        val result = h.core.start()

        assertEquals(Capabilities(completion = true, chat = true, bench = false), result.capabilities)
        assertEquals("ok", result.ollamaStatus.ollama)
        assertEquals("building", result.indexStatus)
        assertEquals(CoreState.READY, h.core.state.value)
        assertEquals("""{"files":1,"buildMs":1}""", indexReady.await().toString())
        h.waitForLog("fake-core: initialize")
    }

    @Test
    fun request_response_matching() = test {
        val h = makeCore(mapOf("FAKE_DELAY_MS" to "50"))
        h.core.start()
        // Concurrent requests: each response must reach its own caller.
        val answers = (1..8).map { i ->
            scope.async { h.core.request("completion/request", completionParams("r$i", line = i, character = i), JsonObject.serializer()) }
        }.awaitAll()
        answers.forEachIndexed { index, answer ->
            val i = index + 1
            val range = answer["items"]!!.let { (it as kotlinx.serialization.json.JsonArray)[0].jsonObject["range"]!!.jsonObject }
            assertEquals("$i", range["start"]!!.jsonObject["line"]!!.jsonPrimitive.content)
            assertEquals("$i", range["start"]!!.jsonObject["character"]!!.jsonPrimitive.content)
        }
        // An error response becomes an RpcException carrying the core's code.
        try {
            h.core.request("no/such/method", JsonObject(emptyMap()), JsonObject.serializer())
            fail("expected RpcException")
        } catch (e: RpcException) {
            assertEquals(-32601, e.error.code)
        }
    }

    @Test
    fun server_to_client_request_answered() = test {
        val h = makeCore()
        val edits = CopyOnWriteArrayList<JsonElement>()
        h.core.onRequest("workspace/applyEdit") { params ->
            edits.add(params)
            buildJsonObject { put("applied", true) }
        }
        h.core.start()
        val done = CompletableDeferred<JsonElement>()
        val results = CopyOnWriteArrayList<JsonElement>()
        h.core.onNotification("chat/toolCall") { p ->
            val o = p.jsonObject
            scope.launch {
                h.core.request("chat/approve", buildJsonObject {
                    put("sessionId", o["sessionId"]!!)
                    put("toolCallId", o["toolCallId"]!!)
                    put("decision", "once")
                }, JsonObject.serializer())
            }
        }
        h.core.onNotification("chat/toolResult") { results.add(it) }
        h.core.onNotification("chat/done") { done.complete(it) }

        val ack = h.core.request("chat/send", buildJsonObject {
            put("sessionId", "s1"); put("message", "hi"); put("attachments", kotlinx.serialization.json.JsonArray(emptyList()))
        }, JsonObject.serializer())

        assertEquals(JsonObject(emptyMap()), ack)
        assertEquals("""{"sessionId":"s1","stopReason":"done"}""", done.await().toString())
        assertEquals(1, edits.size)
        assertEquals("s1", edits[0].jsonObject["sessionId"]!!.jsonPrimitive.content)
        // The fake reports `ok` from our `{applied: true}` answer.
        assertEquals("true", results.single().jsonObject["ok"]!!.jsonPrimitive.content)
    }

    @Test
    fun crash_rejects_pending_and_restarts() = test {
        // Request #1 is initialize; request #2 kills the process before it answers.
        val h = makeCore(mapOf("FAKE_CRASH_AFTER" to "2"))
        h.core.start()
        try {
            h.core.request("completion/request", completionParams("r"), JsonObject.serializer())
            fail("expected CoreCrashed")
        } catch (e: CoreCrashed) {
            assertEquals(1, e.exitCode)
        }
        h.waitForState(CoreState.READY)
        h.waitForLog("fake-core: initialize", 2)
        assertTrue(h.logs.any { it.first == CoreLogLevel.WARN && it.second.contains("restart", ignoreCase = true) })
    }

    @Test
    fun restart_limit_three_per_minute() = test {
        val h = makeCore(mapOf("FAKE_CRASH_AFTER" to "2"))
        h.core.start()
        repeat(3) {
            try {
                h.core.request("ollama/status", JsonObject(emptyMap()), JsonObject.serializer())
                fail("expected CoreCrashed")
            } catch (_: CoreCrashed) {
            }
            h.waitForState(CoreState.READY)
        }
        try {
            h.core.request("ollama/status", JsonObject(emptyMap()), JsonObject.serializer())
            fail("expected CoreCrashed")
        } catch (_: CoreCrashed) {
        }
        h.waitForState(CoreState.CRASHED)
        h.waitForLog("fake-core: initialize", 4)
        delay(200) // no fifth launch
        assertEquals(4, h.count("fake-core: initialize"))
        assertEquals(CoreState.CRASHED, h.core.state.value)
        assertTrue(h.logs.any { it.first == CoreLogLevel.ERROR })
        // A crashed core fails requests immediately instead of hanging.
        try {
            h.core.request("ollama/status", JsonObject(emptyMap()), JsonObject.serializer())
            fail("expected CoreNotRunning")
        } catch (_: CoreNotRunning) {
        }
        // An explicit restart resets the budget.
        h.core.restart()
        assertEquals(CoreState.READY, h.core.state.value)
    }

    @Test
    fun stop_sends_shutdown() = test {
        val h = makeCore()
        h.core.start()
        val exit = h.core.stop()
        assertEquals(0, exit)
        assertTrue(h.logs.any { it.second == "fake-core: shutdown" })
        assertEquals(CoreState.STOPPED, h.core.state.value)
        // Idempotent, and a stopped core never restarts by itself.
        assertEquals(null, h.core.stop())
        delay(200)
        assertEquals(CoreState.STOPPED, h.core.state.value)
    }

    @Test
    fun stop_kills_a_core_that_ignores_shutdown() = test {
        val h = makeCore(mapOf("FAKE_IGNORE_SHUTDOWN" to "1"), shutdownTimeoutMs = 300)
        h.core.start()
        val exit = h.core.stop()
        assertTrue("killed core exit code $exit", exit != null && exit != 0)
        assertEquals(CoreState.STOPPED, h.core.state.value)
    }

    @Test
    fun cancelled_completion_sends_completion_cancel() = test {
        val h = makeCore(mapOf("FAKE_DELAY_MS" to "5000"))
        h.core.start()
        val job = scope.async { h.core.request("completion/request", completionParams("r-cancel"), JsonObject.serializer()) }
        h.waitForLog("fake-core: completion/request")
        job.cancel()
        h.waitForLog("fake-core: completion/cancel")
        assertTrue(job.isCancelled)
    }

    @Test
    fun notifications_before_ready_are_queued_and_index_ready_first_is_delivered() = test {
        val h = makeCore(mapOf("FAKE_INDEX_FIRST" to "1"))
        val seen = CompletableDeferred<CoreState>()
        h.core.onNotification("index/ready") { seen.complete(h.core.state.value) }
        val started = scope.async { h.core.start() }
        h.core.state.first { it != CoreState.STOPPED } // STARTING (READY needs a round trip to the child)
        h.core.notify("textDocument/didSave", buildJsonObject { put("uri", "file:///a.py") })
        started.await()
        assertEquals(CoreState.STARTING, seen.await())
        h.waitForLog("fake-core: textDocument/didSave")
    }

    @Test
    fun spawn_failure_goes_straight_to_crashed() = test {
        val core = CoreProcess(
            scope = scope,
            workspace = workspace,
            command = { CoreCommand(listOf(workspace.resolve("does-not-exist/localpilot-core").toString())) },
            initSettings = { JsonObject(emptyMap()) },
            logLevel = { "info" },
            log = { _, _ -> },
        )
        cores.add(core)
        try {
            core.start()
            fail("expected failure")
        } catch (_: java.io.IOException) {
        }
        assertEquals(CoreState.CRASHED, core.state.value)
    }

    companion object {
        val fakeCore: String = System.getProperty("localpilot.fakeCore")
            ?: File("../vscode/test/fakeCore.mjs").absolutePath

        val node: String by lazy {
            System.getenv("LOCALPILOT_TEST_NODE")
                ?: System.getenv("PATH").orEmpty().split(File.pathSeparator).map { File(it, "node") }.firstOrNull { it.canExecute() }?.path
                ?: File(System.getProperty("user.home"), ".nvm/versions/node").listFiles()
                    ?.sortedByDescending { it.name }?.map { File(it, "bin/node") }?.firstOrNull { it.canExecute() }?.path
                ?: "node"
        }
    }
}
