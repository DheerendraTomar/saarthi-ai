package dev.localpilot.chat

import com.intellij.openapi.Disposable
import dev.localpilot.rpc.CoreCrashed
import dev.localpilot.rpc.CoreState
import dev.localpilot.rpc.RpcException
import dev.localpilot.settings.LocalPilotSettingsState
import dev.localpilot.sync.Position
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class ChatBridgeTest {
    // ------------------------------------------------------------ fakes

    private class FakeCore : ChatCore {
        override val state = MutableStateFlow(CoreState.READY)
        val requests = CopyOnWriteArrayList<Pair<String, JsonElement>>()
        val responders = HashMap<String, suspend (JsonElement) -> JsonElement>()
        private val notificationHandlers = HashMap<String, MutableList<(JsonElement) -> Unit>>()
        val requestHandlers = HashMap<String, suspend (JsonElement) -> JsonElement>()
        var sessions = mutableListOf<String>()
        var newSessionCounter = 0

        init {
            responders["chat/listSessions"] = {
                buildJsonObject {
                    put("sessions", JsonArray(sessions.map { id ->
                        buildJsonObject {
                            put("sessionId", id)
                            put("title", "Title $id")
                            put("updatedAtMs", 1)
                        }
                    }))
                }
            }
            responders["chat/newSession"] = {
                val id = "new${++newSessionCounter}"
                sessions.add(0, id)
                buildJsonObject { put("sessionId", id) }
            }
            responders["chat/history"] = { buildJsonObject { put("messages", JsonArray(emptyList())) } }
            responders["ollama/status"] = { buildJsonObject { put("ollama", "ok"); put("detail", "") } }
        }

        override suspend fun request(method: String, params: JsonElement): JsonElement {
            requests += method to params
            return responders[method]?.invoke(params) ?: JsonObject(emptyMap())
        }

        override fun onNotification(method: String, handler: (JsonElement) -> Unit): Disposable {
            notificationHandlers.getOrPut(method) { mutableListOf() } += handler
            return Disposable { notificationHandlers[method]?.remove(handler) }
        }

        override fun onRequest(method: String, handler: suspend (JsonElement) -> JsonElement): Disposable {
            requestHandlers[method] = handler
            return Disposable { requestHandlers.remove(method) }
        }

        fun emit(method: String, params: JsonObject) = notificationHandlers[method].orEmpty().toList().forEach { it(params) }

        fun methods() = requests.map { it.first }

        fun paramsOf(method: String): JsonObject = requests.last { it.first == method }.second.jsonObject
    }

    private class FakeSettings : ChatSettings {
        var state = LocalPilotSettingsState()
        var failWrites = false
        var writes = 0

        override fun read() = state.snapshot()

        override fun write(change: (LocalPilotSettingsState) -> Unit) {
            if (failWrites) throw IllegalStateException("disk full")
            val next = state.snapshot()
            change(next)
            state = next
            writes++
        }
    }

    private class FakeEditors : ChatEditorHost {
        var active: ActiveFile? = ActiveFile("file:///p/a.py", Position(1, 2), Position(1, 5))
        val inserted = mutableListOf<String>()
        val copied = mutableListOf<String>()
        override suspend fun activeFile() = active
        override fun isAttachable(uri: String) = uri.startsWith("file:///p/")
        override suspend fun insertAtCursor(text: String) {
            inserted += text
        }
        override fun copy(text: String) {
            copied += text
        }
    }

    private class Harness(scope: CoroutineScope) {
        val core = FakeCore()
        val settings = FakeSettings()
        val editors = FakeEditors()
        val posted = CopyOnWriteArrayList<JsonObject>()
        val activeChanges = mutableListOf<Boolean>()
        val bridge = ChatBridge(scope, core, settings, editors, onChatActiveChanged = { activeChanges += it }).also {
            it.ui = UiSink { msg -> posted += msg }
        }

        fun types() = posted.map { it.type }

        fun ofType(type: String) = posted.filter { it.type == type }

        suspend fun ui(json: String) = bridge.handle(Json.parseToJsonElement(json).jsonObject)
    }

    private fun bridgeTest(block: suspend CoroutineScope.(Harness) -> Unit) = runBlocking {
        // Not a child of runBlocking's job (the bridge's state collector never completes); same single-threaded loop.
        val scope = CoroutineScope(coroutineContext + SupervisorJob())
        val h = Harness(scope)
        try {
            withTimeout(10_000) {
                settle()
                block(h)
            }
        } finally {
            h.bridge.dispose()
            scope.cancel()
        }
    }

    // ------------------------------------------------------------ plan tests

    @Test
    fun editedArgs_passed_through_unchanged() = bridgeTest { h ->
        h.core.emit("chat/toolCall", buildJsonObject {
            put("sessionId", "s1")
            put("toolCallId", "t1")
            put("name", "run_command")
            put("args", buildJsonObject { put("command", "ls") })
            put("requiresApproval", true)
        })
        settle()
        val edited = """{"command":"ls -la | head","cwd":"sub","extra":[1,{"x":null}]}"""
        h.ui("""{"type":"chat/approve","toolCallId":"t1","decision":"always","editedArgs":$edited}""")
        val params = h.core.paramsOf("chat/approve")
        assertEquals("s1", params.str("sessionId"))
        assertEquals("t1", params.str("toolCallId"))
        assertEquals("always", params.str("decision"))
        assertEquals(Json.parseToJsonElement(edited), params["editedArgs"])

        h.ui("""{"type":"chat/approve","toolCallId":"t1","decision":"once"}""")
        assertFalse("no editedArgs key when the UI sent none", "editedArgs" in h.core.paramsOf("chat/approve"))
    }

    @Test
    fun crash_mid_turn_emits_error_done() = bridgeTest { h ->
        h.core.sessions = mutableListOf("s1")
        h.ui("""{"type":"ui/ready"}""")
        h.ui("""{"type":"chat/send","message":"hi","attachments":[]}""")
        assertEquals("s1", h.core.paramsOf("chat/send").str("sessionId"))
        assertEquals(listOf(true), h.activeChanges)
        h.posted.clear()

        h.core.state.value = CoreState.STARTING // the core died and is being restarted
        settle()
        val done = h.ofType("chat/done").single()
        assertEquals("s1", done.str("sessionId"))
        assertEquals("error", done.str("stopReason"))
        assertTrue(h.ofType("ui/error").single().str("message")!!.contains("restarting"))
        assertEquals(listOf(true, false), h.activeChanges)

        // Recovery: the restarted core takes the next message; nothing is failed twice.
        h.posted.clear()
        h.core.state.value = CoreState.READY
        settle()
        h.ui("""{"type":"chat/send","message":"again","attachments":[]}""")
        assertEquals(2, h.core.methods().count { it == "chat/send" })
        assertTrue(h.ofType("chat/done").isEmpty())
        assertTrue(h.ofType("ui/error").isEmpty())
        assertTrue("status refreshed after the restart", h.ofType("status").isNotEmpty())

        // A request that dies with the core is not reported a second time.
        h.core.responders["chat/send"] = { throw CoreCrashed(1) }
        h.core.responders["chat/stop"] = { throw CoreCrashed(1) }
        h.ui("""{"type":"chat/stop"}""")
        assertTrue(h.ofType("ui/error").isEmpty())
    }

    @Test
    fun model_select_always_answers_models_list() = bridgeTest { h ->
        h.core.responders["ollama/models"] = { models("qwen-a", "qwen-b") }

        h.ui("""{"type":"model/select","kind":"chat","name":" qwen-b "}""")
        assertEquals("qwen-b", h.settings.state.chatModel)
        var answer = h.ofType("models/list").last()
        assertEquals("qwen-b", answer["current"]!!.jsonObject.str("chat"))
        assertEquals("ok", answer.str("ollama"))

        h.ui("""{"type":"model/select","kind":"completion","name":"qwen-a"}""")
        assertEquals("qwen-a", h.settings.state.completionModel)
        assertEquals("qwen-a", h.ofType("models/list").last()["current"]!!.jsonObject.str("completion"))

        // Not installed: refused, still answered.
        h.posted.clear()
        h.ui("""{"type":"model/select","kind":"chat","name":"evil"}""")
        assertEquals("qwen-b", h.settings.state.chatModel)
        assertEquals(listOf("ui/error", "models/list"), h.types())

        // The write fails: error, and the answer reverts the pick.
        h.posted.clear()
        h.settings.failWrites = true
        h.ui("""{"type":"model/select","kind":"chat","name":"qwen-a"}""")
        assertEquals(listOf("ui/error", "models/list"), h.types())
        answer = h.ofType("models/list").single()
        assertEquals("qwen-b", answer["current"]!!.jsonObject.str("chat"))

        // Garbage kind: still answered.
        h.posted.clear()
        h.ui("""{"type":"model/select","kind":"embedding","name":"qwen-a"}""")
        assertEquals(listOf("models/list"), h.types())
    }

    @Test
    fun models_list_reports_ollama_down_with_error() = bridgeTest { h ->
        h.core.responders["ollama/models"] = { throw RpcException(-32000, "Ollama is not reachable at http://localhost:11434") }
        h.ui("""{"type":"models/list"}""")
        val down = h.ofType("models/list").single()
        assertEquals(JsonArray(emptyList()), down["models"])
        assertEquals("down", down.str("ollama"))
        assertEquals("Ollama is not reachable at http://localhost:11434", down.str("error"))
        assertEquals(LocalPilotSettingsState().chatModel, down["current"]!!.jsonObject.str("chat"))

        // Back up, but the configured model is missing: the status still says so.
        h.core.responders["ollama/models"] = { models("x") }
        h.core.emit("status", buildJsonObject { put("ollama", "modelMissing"); put("detail", "pull it") })
        settle()
        h.posted.clear()
        h.ui("""{"type":"models/list"}""")
        val ok = h.ofType("models/list").single()
        assertEquals("modelMissing", ok.str("ollama"))
        assertEquals(1, ok["models"]!!.jsonArray.size)
        assertFalse("error" in ok)
    }

    @Test
    fun settings_set_always_answers_settings_current() = bridgeTest { h ->
        h.ui(
            """{"type":"settings/set","patch":{"completionMaxTokens":0,"completionDebounceMs":-5.4,
               "completionContextTokens":100.6,"adaptiveCompletions":false,"completionModel":"sneaky","ollamaUrl":"http://evil"}}""",
        )
        val s = h.settings.state
        assertEquals(1, s.completionMaxTokens)
        assertEquals(0, s.completionDebounceMs)
        assertEquals(256, s.completionContextTokens)
        assertFalse(s.adaptiveCompletions)
        assertEquals(LocalPilotSettingsState().completionModel, s.completionModel)
        assertEquals(LocalPilotSettingsState().ollamaUrl, s.ollamaUrl)
        val current = h.ofType("settings/current").single()["settings"]!!.jsonObject
        assertEquals(1, current["completionMaxTokens"]!!.jsonPrimitive.content.toInt())
        assertEquals(256, current["completionContextTokens"]!!.jsonPrimitive.content.toInt())
        assertEquals("false", current["adaptiveCompletions"]!!.jsonPrimitive.content)
        assertEquals(s.completionModel, current.str("completionModel"))

        h.ui("""{"type":"settings/set","patch":{"completionMaxTokens":40.6,"completionDebounceMs":"300"}}""")
        assertEquals(41, h.settings.state.completionMaxTokens)
        assertEquals("a string is not a number", 0, h.settings.state.completionDebounceMs)

        // Failure: an error, then the committed values.
        h.posted.clear()
        h.settings.failWrites = true
        h.ui("""{"type":"settings/set","patch":{"completionMaxTokens":99}}""")
        assertEquals(listOf("ui/error", "settings/current"), h.types())
        assertEquals(41, h.ofType("settings/current").single()["settings"]!!.jsonObject["completionMaxTokens"]!!.jsonPrimitive.content.toInt())

        // Nothing writable and settings/get: just the answer.
        h.posted.clear()
        h.ui("""{"type":"settings/set","patch":null}""")
        h.ui("""{"type":"settings/get"}""")
        assertEquals(listOf("settings/current", "settings/current"), h.types())
    }

    @Test
    fun session_delete_running_turn_posts_ui_error() = bridgeTest { h ->
        h.core.sessions = mutableListOf("s1", "s2")
        h.ui("""{"type":"ui/ready"}""")
        h.posted.clear()
        h.core.responders["chat/deleteSession"] = { throw RpcException(-32602, "turn running in session s1") }
        h.ui("""{"type":"session/delete","sessionId":"s1"}""")
        assertEquals(listOf("ui/error"), h.types())
        assertTrue(h.posted.single().str("message")!!.contains("still running"))

        // Success: session/deleted with the next session, then the refreshed list.
        h.posted.clear()
        h.core.responders["chat/deleteSession"] = { p ->
            h.core.sessions.remove(p.jsonObject.str("sessionId"))
            JsonObject(emptyMap())
        }
        h.ui("""{"type":"session/delete","sessionId":"s1"}""")
        assertEquals(listOf("session/deleted", "session/list"), h.types())
        assertEquals("s2", h.posted[0].str("next"))
        assertEquals("s2", h.posted[1].str("current"))

        // Deleting the last one: next is null.
        h.posted.clear()
        h.ui("""{"type":"session/delete","sessionId":"s2"}""")
        assertEquals(JsonNull, h.posted[0]["next"])
        assertEquals(JsonNull, h.posted[1]["current"])
    }

    @Test
    fun reset_learning_then_stats_in_order() = bridgeTest { h ->
        val gate = CompletableDeferred<Unit>()
        var reset = false
        h.core.responders["completion/resetLearning"] = {
            gate.await()
            reset = true
            JsonObject(emptyMap())
        }
        h.core.responders["completion/stats"] = { buildJsonObject { put("accepted", if (reset) 0 else 42) } }
        launch { h.ui("""{"type":"completion/resetLearning"}""") }
        launch { h.ui("""{"type":"completion/stats"}""") }
        settle()
        assertEquals(listOf("completion/resetLearning"), h.core.methods())
        assertTrue(h.ofType("completion/stats").isEmpty())
        gate.complete(Unit)
        settle()
        assertEquals(listOf("completion/resetLearning", "completion/stats"), h.core.methods())
        assertEquals("0", h.ofType("completion/stats").single()["stats"]!!.jsonObject["accepted"]!!.jsonPrimitive.content)
    }

    @Test
    fun ui_ready_posts_session_list_before_turn_events() = bridgeTest { h ->
        h.core.sessions = mutableListOf("s1")
        h.ui("""{"type":"ui/ready"}""")
        h.ui("""{"type":"chat/send","message":"hi","attachments":[]}""")
        h.core.emit("chat/toolCall", buildJsonObject {
            put("sessionId", "s1")
            put("toolCallId", "t1")
            put("name", "write_file")
            put("args", buildJsonObject { put("path", "a.py") })
            put("requiresApproval", true)
        })
        settle()

        // The page reloads: the list must come before any turn event, even one that arrives meanwhile.
        h.posted.clear()
        val listGate = CompletableDeferred<Unit>()
        val list = h.core.responders.getValue("chat/listSessions")
        h.core.responders["chat/listSessions"] = { p ->
            listGate.await()
            list(p)
        }
        launch { h.ui("""{"type":"ui/ready"}""") }
        settle()
        h.core.emit("chat/token", buildJsonObject {
            put("sessionId", "s1")
            put("text", "tok")
        })
        settle()
        assertTrue("nothing before the session list: ${h.types()}", h.posted.isEmpty())
        listGate.complete(Unit)
        settle()
        assertEquals(
            listOf("session/list", "chat/token", "session/history", "chat/toolCall", "chat/turnState", "status", "ui/activeFile"),
            h.types(),
        )
        assertEquals("s1", h.posted[0].str("current"))
        assertEquals("t1", h.posted[3].str("toolCallId"))
        assertEquals("true", h.posted[4]["running"]!!.jsonPrimitive.content)
        assertEquals("file:///p/a.py", h.posted[6].str("uri"))
    }

    @Test
    fun double_ready_keeps_all_held_events_in_order() = bridgeTest { h ->
        h.core.sessions = mutableListOf("s1")
        // Each ui/ready's chat/listSessions waits on its own gate, so the first can finish while the second still waits.
        val gates = listOf(CompletableDeferred<Unit>(), CompletableDeferred<Unit>())
        var calls = 0
        val list = h.core.responders.getValue("chat/listSessions")
        h.core.responders["chat/listSessions"] = { p ->
            gates.getOrNull(calls++)?.await()
            list(p)
        }
        fun token(text: String) = h.core.emit("chat/token", buildJsonObject {
            put("sessionId", "s1")
            put("text", text)
        })
        launch { h.ui("""{"type":"ui/ready"}""") }
        settle()
        token("a")
        settle()
        launch { h.ui("""{"type":"ui/ready"}""") }
        settle()
        token("b")
        settle()
        assertTrue("nothing before a session list: ${h.types()}", h.posted.isEmpty())

        // The first ready finishes while the second is still fetching: no token may pass the second's list.
        gates[0].complete(Unit)
        settle()
        assertTrue("no token before the second list: ${h.types()}", h.ofType("chat/token").isEmpty())
        gates[1].complete(Unit)
        settle()
        assertEquals(listOf("a", "b"), h.ofType("chat/token").map { it.str("text") })
        val lastList = h.types().lastIndexOf("session/list")
        val firstToken = h.types().indexOf("chat/token")
        assertTrue("tokens after every session/list: ${h.types()}", firstToken > lastList)
        assertEquals(2, h.ofType("session/list").size)

        // Afterwards events flow straight through again.
        h.posted.clear()
        token("c")
        settle()
        assertEquals(listOf("chat/token"), h.types())
    }

    @Test
    fun delete_running_session_posts_stopped_done() = bridgeTest { h ->
        h.core.sessions = mutableListOf("s1", "s2")
        h.ui("""{"type":"ui/ready"}""")
        h.ui("""{"type":"chat/send","message":"hi","attachments":[]}""") // the bridge thinks s1's turn runs
        h.core.responders["chat/deleteSession"] = { p ->
            h.core.sessions.remove(p.jsonObject.str("sessionId"))
            JsonObject(emptyMap())
        }
        h.posted.clear()
        h.ui("""{"type":"session/delete","sessionId":"s1"}""")
        assertEquals(listOf("chat/done", "session/deleted", "session/list"), h.types())
        assertEquals("s1", h.posted[0].str("sessionId"))
        assertEquals("stopped", h.posted[0].str("stopReason"))
        assertEquals(listOf(true, false), h.activeChanges)
    }

    // ------------------------------------------------------------ more bridge behaviour

    @Test
    fun core_notifications_are_flattened_for_all_sessions() = bridgeTest { h ->
        h.core.sessions = mutableListOf("s1", "s2")
        h.ui("""{"type":"ui/ready"}""")
        h.posted.clear()
        h.core.emit("chat/done", buildJsonObject {
            put("sessionId", "s2")
            put("stopReason", "done")
        })
        h.core.emit("ollama/pullProgress", buildJsonObject {
            put("model", "m")
            put("type", "spoofed")
        })
        settle()
        val done = h.posted.first()
        assertEquals("chat/done", done.type)
        assertEquals("s2", done.str("sessionId"))
        assertEquals("done", done.str("stopReason"))
        assertTrue("finished turn refreshes the list", "session/list" in h.types())
        assertEquals("ollama/pullProgress", h.ofType("ollama/pullProgress").single().type)
    }

    @Test
    fun session_clear_all_posts_deleted_per_session_and_keeps_running() = bridgeTest { h ->
        h.core.sessions = mutableListOf("s1", "s2", "s3")
        h.ui("""{"type":"ui/ready"}""")
        h.posted.clear()
        h.core.responders["chat/clearSessions"] = {
            h.core.sessions = mutableListOf("s2")
            buildJsonObject {
                put("deleted", 2)
                put("skipped", buildJsonArray { add(JsonPrimitive("s2")) })
            }
        }
        h.ui("""{"type":"session/clearAll"}""")
        assertEquals(listOf("session/deleted", "session/deleted", "ui/error", "session/list"), h.types())
        assertEquals(listOf("s1", "s3"), h.ofType("session/deleted").map { it.str("sessionId") })
        assertTrue(h.ofType("session/deleted").all { it.str("next") == "s2" })
        assertEquals("s2", h.ofType("session/list").single().str("current"))
    }

    @Test
    fun send_without_session_creates_one_and_lists_it_first() = bridgeTest { h ->
        h.ui("""{"type":"chat/send","message":"hi","attachments":[{"uri":"file:///p/a.py","range":{"start":{"line":0,"character":0},"end":{"line":"x"}}},{"uri":"file:///etc/passwd"}]}""")
        assertEquals(listOf("chat/newSession", "chat/listSessions", "chat/send"), h.core.methods())
        assertEquals(listOf("session/list"), h.types())
        val params = h.core.paramsOf("chat/send")
        assertEquals("new1", params.str("sessionId"))
        val attachments = params["attachments"]!!.jsonArray
        assertEquals(1, attachments.size)
        assertEquals("file:///p/a.py", attachments[0].jsonObject.str("uri"))
        assertFalse("malformed range dropped", "range" in attachments[0].jsonObject)
    }

    @Test
    fun send_while_turn_running_and_stop_targets_running_session() = bridgeTest { h ->
        h.core.sessions = mutableListOf("s1", "s2")
        h.ui("""{"type":"ui/ready"}""")
        h.ui("""{"type":"chat/send","message":"hi","attachments":[]}""") // s1 running
        h.ui("""{"type":"chat/switchSession","sessionId":"s2"}""")
        h.ui("""{"type":"chat/stop"}""")
        assertEquals("s1", h.core.paramsOf("chat/stop").str("sessionId"))

        h.posted.clear()
        h.core.responders["chat/send"] = { throw RpcException(-32602, "turn running") }
        h.ui("""{"type":"chat/switchSession","sessionId":"s1"}""")
        h.posted.clear()
        h.ui("""{"type":"chat/send","message":"again","attachments":[]}""")
        assertEquals(listOf("ui/error"), h.types())

        // Nothing running: Stop goes to the current session (the core ignores it if idle).
        h.core.emit("chat/done", buildJsonObject { put("sessionId", "s1"); put("stopReason", "stopped") })
        settle()
        h.posted.clear()
        h.ui("""{"type":"chat/stop"}""")
        assertEquals("s1", h.core.paramsOf("chat/stop").str("sessionId"))
    }

    @Test
    fun send_failure_ends_turn_with_error() = bridgeTest { h ->
        h.core.sessions = mutableListOf("s1")
        h.ui("""{"type":"ui/ready"}""")
        h.posted.clear()
        h.core.responders["chat/send"] = { throw IllegalStateException("boom") }
        h.ui("""{"type":"chat/send","message":"hi","attachments":[]}""")
        assertEquals(listOf("chat/done", "ui/error"), h.types())
        assertEquals("error", h.posted[0].str("stopReason"))
        assertEquals(listOf(true, false), h.activeChanges)
    }

    @Test
    fun stop_with_nothing_to_stop_posts_done() = bridgeTest { h ->
        h.ui("""{"type":"chat/stop"}""")
        assertTrue(h.core.methods().none { it == "chat/stop" })
        val done = h.ofType("chat/done").single()
        assertEquals("", done.str("sessionId"))
        assertEquals("stopped", done.str("stopReason"))
    }

    @Test
    fun host_hooks_answer_core_requests_and_ollama_buttons() = bridgeTest { h ->
        val applyParams = buildJsonObject { put("ops", JsonArray(emptyList())); put("save", true) }
        // Not wired yet: a well-formed failure.
        val notWired = h.core.requestHandlers.getValue(ChatBridge.APPLY_EDIT)(applyParams).jsonObject
        assertEquals("false", notWired["applied"]!!.jsonPrimitive.content)
        assertTrue("error" in notWired)

        val seen = mutableListOf<String>()
        h.bridge.hooks = HostHooks(
            edits = object : EditApplier {
                override suspend fun apply(params: JsonElement): JsonElement {
                    seen += "apply:${params.jsonObject["save"]}"
                    return buildJsonObject { put("applied", true) }
                }
            },
            commands = object : CommandRunner {
                override suspend fun run(params: JsonElement): JsonElement {
                    seen += "run:${params.jsonObject.str("command")}"
                    return buildJsonObject { put("exitCode", 0); put("stdout", "ok"); put("stderr", "") }
                }
            },
            ollama = object : OllamaActions {
                override fun start() {
                    seen += "start"
                }
                override suspend fun pull(model: String) {
                    seen += "pull:$model"
                }
            },
        )
        assertEquals("true", h.core.requestHandlers.getValue(ChatBridge.APPLY_EDIT)(applyParams).jsonObject["applied"]!!.jsonPrimitive.content)
        h.core.requestHandlers.getValue(ChatBridge.RUN_COMMAND)(buildJsonObject { put("command", "pytest") })
        h.ui("""{"type":"ollama/start"}""")
        h.ui("""{"type":"ollama/pull","model":"qwen"}""")
        h.ui("""{"type":"ui/insertAtCursor","text":"x = 1"}""")
        h.ui("""{"type":"ui/copy","text":"y"}""")
        assertEquals(listOf("apply:true", "run:pytest", "start", "pull:qwen"), seen)
        assertEquals(listOf("x = 1"), h.editors.inserted)
        assertEquals(listOf("y"), h.editors.copied)
    }

    @Test
    fun active_file_is_posted_only_when_it_changes() = bridgeTest { h ->
        h.bridge.activeFileChanged()
        settle()
        h.bridge.activeFileChanged()
        settle()
        assertEquals(1, h.ofType("ui/activeFile").size)
        val sel = h.posted[0]["selection"]!!.jsonObject
        assertEquals(Json.parseToJsonElement("""{"line":1,"character":2}"""), sel["start"])
        h.editors.active = null
        h.bridge.activeFileChanged()
        settle()
        val none = h.ofType("ui/activeFile").last()
        assertEquals(JsonNull, none["uri"])
        assertFalse("selection" in none)
    }

    @Test
    fun ui_ready_with_core_down_still_lists_and_reports() = bridgeTest { h ->
        h.core.responders["chat/listSessions"] = { throw IllegalStateException("not running") }
        h.ui("""{"type":"ui/ready"}""")
        assertEquals(listOf("session/list", "ui/error", "status", "ui/activeFile"), h.types())
        assertEquals(JsonArray(emptyList()), h.posted[0]["sessions"])
    }

    @Test
    fun malformed_ui_messages_are_ignored() = bridgeTest { h ->
        h.bridge.receive("not json")
        h.bridge.receive("[1,2]")
        h.bridge.receive("""{"type":42}""")
        h.bridge.receive("""{"type":"ui/openDiff","toolCallId":"t"}""")
        settle()
        assertTrue(h.posted.isEmpty())
        assertTrue(h.core.requests.isEmpty())
        h.bridge.receive("""{"type":"settings/get"}""")
        settle()
        assertEquals(listOf("settings/current"), h.types())
    }

    // ------------------------------------------------------------ pure helpers

    @Test
    fun settings_writes_ignore_unknown_and_completion_model() {
        val s = LocalPilotSettingsState()
        val writes = ChatBridge.settingsWrites(Json.parseToJsonElement("""{"completionModel":"x","foo":1,"completionContextTokens":1e12}"""))
        writes.forEach { it(s) }
        assertEquals(1, writes.size)
        assertEquals(Int.MAX_VALUE, s.completionContextTokens)
        assertEquals(LocalPilotSettingsState().completionModel, s.completionModel)
    }

    @Test
    fun html_puts_shim_before_bundle_script() {
        val template = """<!doctype html><html><head><meta charset="utf-8"><script type="module">boot()</script></head><body></body></html>"""
        val shim = ChatHtml.cefQueryShim { q, ok, fail -> "window.cefQuery_1_1({request: '' + $q, onSuccess: $ok, onFailure: $fail});" }
        val html = ChatHtml.render(template, shim, ChatTheme.rootStyle(mapOf("--vscode-foreground" to "#ffffff")))
        val shimAt = html.indexOf("window.cefQuery = function")
        assertTrue(shimAt > 0)
        assertTrue(shimAt < html.indexOf("type=\"module\""))
        assertTrue(html.indexOf("Content-Security-Policy") < shimAt)
        assertTrue(html.contains(":root{--vscode-foreground:#ffffff;}"))
        assertTrue(shim.contains("window.cefQuery_1_1({request: '' + request"))

        val missing = ChatHtml.render(null, shim, "")
        assertTrue(missing.contains("scripts/package-jetbrains.sh"))
        assertTrue(missing.contains("window.cefQuery = function"))
    }

    @Test
    fun navigation_allows_only_own_page_and_opens_links_externally() {
        val own = ChatHtml.PAGE_URL
        for (loaded in listOf(false, true)) {
            assertTrue(ChatHtml.isAllowedNavigation(own, own, pageLoaded = loaded))
            assertTrue("in-page anchor", ChatHtml.isAllowedNavigation("$own#top", own, pageLoaded = loaded))
        }
        for (url in listOf(
            "https://example.com/",
            "http://localhost:11434/api/tags",
            "mailto:a@b.c",
            "file:///etc/passwd",
            "file:///jbcefbrowser/other.html",
            "$own.evil",
            "${own}x",
            "javascript:alert(1)",
            "data:text/html,<script>x</script>",
            "about:blankx",
            "",
        )) {
            assertFalse(url, ChatHtml.isAllowedNavigation(url, own, pageLoaded = false))
            assertFalse(url, ChatHtml.isAllowedNavigation(url, own, pageLoaded = true))
        }
        assertTrue(ChatHtml.opensExternally("https://example.com/a?b#c"))
        assertTrue(ChatHtml.opensExternally("HTTP://example.com"))
        assertTrue(ChatHtml.opensExternally("mailto:a@b.c"))
        assertFalse(ChatHtml.opensExternally("file:///etc/passwd"))
        assertFalse(ChatHtml.opensExternally("javascript:alert(1)"))
        assertFalse(ChatHtml.opensExternally("not a url"))
    }

    @Test
    fun about_blank_is_allowed_only_before_the_page_has_loaded() {
        val own = ChatHtml.PAGE_URL
        assertTrue("the browser's initial blank page", ChatHtml.isAllowedNavigation("about:blank", own, pageLoaded = false))
        assertFalse("Back must not blank the chat", ChatHtml.isAllowedNavigation("about:blank", own, pageLoaded = true))
    }

    @Test
    fun cancelled_links_open_externally_only_on_a_user_gesture_in_the_main_frame() {
        for (url in listOf("https://example.com/", "mailto:a@b.c")) {
            assertTrue(url, ChatHtml.opensExternally(url, userGesture = true, isMainFrame = true))
            assertTrue("$url, frame unknown", ChatHtml.opensExternally(url, userGesture = true, isMainFrame = null))
            assertFalse("$url, script navigation", ChatHtml.opensExternally(url, userGesture = false, isMainFrame = true))
            assertFalse("$url, script navigation", ChatHtml.opensExternally(url, userGesture = false, isMainFrame = null))
            assertFalse("$url, sub-frame", ChatHtml.opensExternally(url, userGesture = true, isMainFrame = false))
        }
        for (url in listOf("file:///etc/passwd", "javascript:alert(1)", "not a url")) {
            assertFalse(url, ChatHtml.opensExternally(url, userGesture = true, isMainFrame = true))
        }
    }

    @Test
    fun html_keeps_charset_first_in_head() {
        val bigTheme = ChatTheme.rootStyle(mapOf("--vscode-font-family" to "\"" + "x".repeat(3000) + "\""))
        val template = """<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>t</title><script type="module">boot()</script></head><body></body></html>"""
        val html = ChatHtml.render(template, "shim()", bigTheme)
        val charset = html.indexOf("<meta charset=\"UTF-8\">")
        assertTrue(charset in 0 until 1024)
        assertTrue(charset < html.indexOf("Content-Security-Policy"))
        assertTrue(html.indexOf("shim()") < html.indexOf("type=\"module\""))
        assertEquals(1, Regex("<meta charset", RegexOption.IGNORE_CASE).findAll(html).count())

        // No charset in the bundle: one is put first.
        val bare = ChatHtml.render("""<html><head><script type="module">boot()</script></head></html>""", "shim()", bigTheme)
        assertTrue(bare.startsWith("""<html><head><meta charset="utf-8">"""))
        assertTrue(bare.indexOf("shim()") < bare.indexOf("type=\"module\""))
    }

    @Test
    fun post_script_escapes_the_message_as_a_js_string() {
        val msg = buildJsonObject {
            put("type", "chat/token")
            put("text", "a'b\"c</script>\u2028\u2029\n")
        }
        val js = ChatHtml.postScript(msg)
        assertTrue(js.startsWith("window.postMessage(JSON.parse(\""))
        assertFalse(js.contains("</script>"))
        assertFalse(js.contains("\u2028"))
        assertFalse(js.contains("\u2029"))
        assertTrue(js.contains("\\u2028"))
        assertFalse(js.contains("\n"))
        // The literal decodes back to the message's JSON.
        val literal = js.removePrefix("window.postMessage(JSON.parse(").removeSuffix("), '*');")
        assertEquals(msg, Json.parseToJsonElement(Json.decodeFromString<String>(literal.replace("<\\/", "</"))))
    }

    @Test
    fun theme_style_drops_unsafe_values_and_names() {
        val css = ChatTheme.rootStyle(
            mapOf(
                "--vscode-foreground" to "#010203",
                "--vscode-font-family" to "\"JetBrains Mono\", monospace",
                "--vscode-evil" to "red;}</style><script>",
                "--other" to "#fff",
            ),
        )
        assertEquals("<style id=\"localpilot-theme\">:root{--vscode-foreground:#010203;--vscode-font-family:\"JetBrains Mono\", monospace;}</style>", css)
        assertEquals("rgba(1, 2, 3, 0.502)", ChatTheme.cssColor(java.awt.Color(1, 2, 3, 128)))
        assertEquals("#0a0b0c", ChatTheme.cssColor(java.awt.Color(10, 11, 12)))
        assertEquals("\"Inter\", sans-serif", ChatTheme.cssFontFamily("Inter\";}<>", "sans-serif"))
        val msg = ChatTheme.themeMessage(mapOf("--vscode-foreground" to "#000000", "--vscode-x" to "a{b"))
        assertEquals("ui/theme", msg.type)
        assertEquals(setOf("--vscode-foreground"), msg["vars"]!!.jsonObject.keys)
    }

    // ------------------------------------------------------------ helpers

    private companion object {
        suspend fun settle() = repeat(50) { yield() }

        fun models(vararg names: String) = buildJsonObject {
            put("models", JsonArray(names.map { n ->
                buildJsonObject {
                    put("name", n)
                    put("sizeBytes", 1)
                    put("supportsInsert", true)
                    put("supportsTools", true)
                }
            }))
        }

        val JsonObject.type: String? get() = str("type")

        fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}

/** The IDE side of the bridge ([IdeChatEditorHost]) against real editors; runs on the EDT. */
class ChatEditorHostTest : com.intellij.testFramework.fixtures.BasePlatformTestCase() {
    fun test_active_file_reports_uri_and_selection_of_tracked_file() {
        myFixture.configureByText("a.py", "x = 1\ny = <selection>22</selection>\n")
        val host = IdeChatEditorHost(project) { true }
        val active = host.activeFileNow()!!
        assertEquals(dev.localpilot.sync.documentUri(myFixture.file.virtualFile), active.uri)
        assertEquals(Position(1, 4), active.start)
        assertEquals(Position(1, 6), active.end)
    }

    fun test_active_file_is_null_for_untracked_file() {
        myFixture.configureByText("a.py", "x = 1\n")
        assertNull(IdeChatEditorHost(project) { false }.activeFileNow())
    }

    fun test_insert_replaces_selection_and_is_undoable() {
        myFixture.configureByText("a.py", "x = <selection>1</selection>\n")
        assertTrue(IdeChatEditorHost(project) { true }.insertNow("compute()"))
        myFixture.checkResult("x = compute()<caret>\n")
        val fileEditor = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).getSelectedEditor(myFixture.file.virtualFile)
        com.intellij.openapi.command.undo.UndoManager.getInstance(project).undo(fileEditor)
        myFixture.checkResult("x = 1\n")
    }

    fun test_attachable_only_inside_the_project() {
        val host = IdeChatEditorHost(project) { true }
        val root = dev.localpilot.rpc.LocalPilotCore.getInstance(project).workspace
        assertNotNull("the test project has a workspace root", root)
        assertTrue(host.isAttachable(root!!.resolve("pkg/a.py").toUri().toString()))
        assertFalse(host.isAttachable("file:///definitely/not/in/project/a.py"))
        assertFalse(host.isAttachable("https://example.com/a.py"))
        assertFalse(host.isAttachable("not a uri"))
    }
}
