package dev.localpilot.chat

import com.intellij.openapi.Disposable
import dev.localpilot.rpc.CoreCrashed
import dev.localpilot.rpc.CoreNotRunning
import dev.localpilot.rpc.CoreProcess
import dev.localpilot.rpc.CoreState
import dev.localpilot.rpc.RpcException
import dev.localpilot.settings.LocalPilotSettingsState
import dev.localpilot.sync.Position
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlin.coroutines.ContinuationInterceptor
import kotlin.math.roundToLong

/** The core as the chat bridge sees it (a thin view of [CoreProcess]; tests substitute a fake). */
interface ChatCore {
    val state: StateFlow<CoreState>

    /** Raw JSON result; throws [RpcException], [CoreCrashed] or [dev.localpilot.rpc.CoreNotRunning]. */
    suspend fun request(method: String, params: JsonElement): JsonElement

    fun onNotification(method: String, handler: (JsonElement) -> Unit): Disposable

    fun onRequest(method: String, handler: suspend (JsonElement) -> JsonElement): Disposable
}

class CoreProcessChatCore(private val process: CoreProcess) : ChatCore {
    override val state: StateFlow<CoreState> get() = process.state
    override suspend fun request(method: String, params: JsonElement): JsonElement = process.requestJson(method, params)
    override fun onNotification(method: String, handler: (JsonElement) -> Unit): Disposable = process.onNotification(method, handler)
    override fun onRequest(method: String, handler: suspend (JsonElement) -> JsonElement): Disposable = process.onRequest(method, handler)
}

/** Reads and writes the LocalPilot settings (production: `LocalPilotSettings`; a write restarts the core as needed). */
interface ChatSettings {
    fun read(): LocalPilotSettingsState

    /** Applies [change] to a copy of the settings and stores it; throws if the write failed. */
    fun write(change: (LocalPilotSettingsState) -> Unit)
}

/** The selected editor's synced document (a file or a notebook cell's virtual uri) and its selection. */
data class ActiveFile(val uri: String, val start: Position, val end: Position)

/** The IDE side of the bridge: the selected editor, insertion and the clipboard. Implementations handle threading. */
interface ChatEditorHost {
    /** The selected editor's synced uri + selection, or null when none is attachable (read under a read action). */
    suspend fun activeFile(): ActiveFile?

    /** Whether [uri] names a document the core syncs (a project file or a notebook cell's virtual uri). */
    fun isAttachable(uri: String): Boolean

    /** Replaces the selection(s) of the selected editor with [text] (undoable write command on the EDT). */
    suspend fun insertAtCursor(text: String)

    fun copy(text: String)
}

/** Where host → UI messages go (production: `window.postMessage` in the JCEF browser). */
fun interface UiSink {
    fun post(message: JsonObject)
}

/**
 * Bridges the shared chat UI and the core, following `vscode/src/chat/chatView.ts`: UI messages become core requests
 * (with the current session filled in) and core chat notifications go to the UI flattened as `{ type: <method>, ...params }`.
 * If the core goes away while a turn is running, the UI gets `chat/done { stopReason: "error" }` and a `ui/error`, so it
 * never waits on a turn that cannot finish; the next message after the restart goes to the new core.
 *
 * Threading: every piece of bridge state is touched only by coroutines on [scope], whose dispatcher must run one task
 * at a time in FIFO order (production: `Dispatchers.Default.limitedParallelism(1)`; tests: `runBlocking`). Core
 * notifications, core state changes and UI messages ([receive]) are hopped onto it in arrival order; settings writes,
 * session deletions and stats/reset requests are additionally serialised per group (fair mutexes).
 *
 * The bridge also answers the core's `workspace/applyEdit` / `workspace/runCommand` requests through [hooks].
 */
class ChatBridge(
    private val scope: CoroutineScope,
    private val core: ChatCore,
    private val settings: ChatSettings,
    private val editors: ChatEditorHost,
    hooks: HostHooks = HostHooks(),
    /** Called when the first chat turn starts (true) and when the last one ends (false). */
    private val onChatActiveChanged: (Boolean) -> Unit = {},
) : Disposable {
    @Volatile
    var hooks: HostHooks = hooks

    /** The open chat view; null while the tool window has no browser (messages are then dropped, as in VS Code). */
    @Volatile
    var ui: UiSink? = null

    private var current: String? = null
    private var sessions: List<JsonObject> = emptyList()
    private var status: JsonObject? = null
    /** Sessions with a turn the UI is waiting on (`chat/send` until `chat/done`). */
    private val activeTurns = LinkedHashSet<String>()
    /** Which session a tool call belongs to, for `chat/approve`. */
    private val toolCallSessions = HashMap<String, String>()
    /** Per session, the `chat/toolCall` params of calls still awaiting a decision; re-sent after `session/history`. */
    private val pendingCalls = HashMap<String, LinkedHashMap<String, JsonObject>>()
    private var lastActiveFile: JsonObject? = null
    private var lastKnownModels: JsonArray? = null
    /** While `ui/ready` fetches the session list, relayed core events wait here (the list must come first). */
    private var heldEvents: MutableList<JsonObject>? = null
    /** Counts `ui/ready`s; only the latest releases [heldEvents] (an earlier one's list may precede the page's last). */
    private var readyGeneration = 0
    private var lastState: CoreState? = null
    /** The last `ui/ready` could not reach the core: answer it again on the next transition into READY. */
    private var readyFailed = false
    private val chains = mapOf("settings" to Mutex(), "sessions" to Mutex(), "completion" to Mutex())
    private val subscriptions = mutableListOf<Disposable>()
    private val stateJob: Job

    init {
        for (method in RELAYED) {
            subscriptions += core.onNotification(method) { params -> scope.launch { onCoreNotification(method, params) } }
        }
        subscriptions += core.onRequest(APPLY_EDIT) { params -> this.hooks.edits.apply(params) }
        subscriptions += core.onRequest(RUN_COMMAND) { params -> this.hooks.commands.run(params) }
        // Unconfined: the collector runs as the state is set, so a quick crash → restart is not conflated away.
        stateJob = scope.launch(Dispatchers.Unconfined) {
            core.state.collect { state -> scope.launch { onCoreState(state) } }
        }
    }

    // ------------------------------------------------------------ public API (tool window, actions)

    /** A raw `UiToHost` message from the page (any thread). Malformed messages are ignored. */
    fun receive(raw: String) {
        val msg = try {
            JSON.parseToJsonElement(raw) as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return
        scope.launch { handle(msg) }
    }

    /** The editor selection may have changed: re-sends `ui/activeFile` if it did (any thread). */
    fun activeFileChanged() {
        scope.launch { postActiveFile(force = false) }
    }

    /** Posts a host-originated message (e.g. `ui/theme`) as is. */
    fun postRaw(message: JsonObject) = post(message)

    suspend fun currentSessionId(): String? = onBridge { current }

    /** Latest Ollama status (`{ ollama, detail }`); forwarded to the UI. */
    suspend fun setStatus(status: JsonObject) = onBridge {
        this.status = status
        post(withType("status", status))
    }

    /** Starts a new chat session and shows it (NewSession action). */
    suspend fun newSession() = onBridge { newSessionInternal() }

    /** Core `chat/deleteSession` (see [deleteSessionInternal]); returns the error message, or null on success. */
    suspend fun deleteSession(sessionId: String): String? = onBridge {
        chains.getValue("sessions").withLock { deleteSessionInternal(sessionId) }
    }

    /** Core `chat/clearSessions`; returns (deleted, skipped) session ids; throws when the core refused. */
    suspend fun clearSessions(): Pair<List<String>, List<String>> = onBridge {
        chains.getValue("sessions").withLock { clearSessionsInternal() }
    }

    /** Sends a fresh `models/list` (e.g. after a model was picked from an action). */
    suspend fun postModels() = onBridge { postModelsInternal() }

    override fun dispose() {
        stateJob.cancel()
        for (d in subscriptions) d.dispose()
        subscriptions.clear()
        ui = null
    }

    // ------------------------------------------------------------ UI → core

    /** Handles one `UiToHost` message; must run on the bridge scope (tests call it directly). */
    suspend fun handle(msg: JsonObject) {
        val type = msg.str("type") ?: return
        try {
            when (type) {
                "ui/ready" -> onReady()
                "chat/send" -> send(msg.str("message") ?: "", validAttachments(msg["attachments"]))
                "chat/stop" -> {
                    // The turn on screen, else the one running elsewhere (Stop shows only while one runs).
                    val c = current
                    val target = if (c != null && c in activeTurns) c else activeTurns.lastOrNull() ?: c
                    if (target != null) {
                        core.request("chat/stop", buildJsonObject { put("sessionId", target) })
                    } else {
                        // Nothing to stop in the core: still end the UI's turn so Stop always unsticks the composer.
                        post(done("", "stopped"))
                    }
                }
                "chat/approve" -> approve(msg)
                "chat/newSession" -> newSessionInternal()
                "chat/switchSession" -> msg.str("sessionId")?.let { switchSession(it) }
                "ui/insertAtCursor" -> editors.insertAtCursor(msg.str("text") ?: "")
                "ui/copy" -> editors.copy(msg.str("text") ?: "")
                "ollama/start" -> hooks.ollama.start()
                "ollama/pull" -> hooks.ollama.pull(msg.str("model") ?: "")
                "models/list" -> postModelsInternal()
                "model/select" -> chains.getValue("settings").withLock { selectModel(msg["kind"], msg["name"]) }
                "settings/get" -> postSettings()
                "settings/set" -> chains.getValue("settings").withLock { applySettings(msg["patch"]) }
                "session/delete" -> msg.str("sessionId")?.let { id ->
                    chains.getValue("sessions").withLock { deleteSessionInternal(id) }
                }
                // clearSessionsInternal already told the UI about a failure.
                "session/clearAll" -> chains.getValue("sessions").withLock {
                    try {
                        clearSessionsInternal()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                    }
                }
                "completion/stats" -> chains.getValue("completion").withLock { postStats() }
                // Awaited under the same lock as the stats request the UI sends right after, so it never sees pre-reset numbers.
                "completion/resetLearning" -> chains.getValue("completion").withLock {
                    core.request("completion/resetLearning", JsonObject(emptyMap()))
                }
                else -> Unit // ui/openDiff and unknown messages: nothing to do
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // A crash is reported once, by the state handler.
            if (e !is CoreCrashed) postError(errorMessage(e))
        }
    }

    private suspend fun onReady() {
        // Order matters: the UI keys tool cards by session, so the list goes before any turn event. A ready that
        // arrives while an earlier one is still fetching keeps the events held so far and takes over releasing them.
        val generation = ++readyGeneration
        if (heldEvents == null) heldEvents = mutableListOf()
        try {
            postSessionList()
            readyFailed = false
            if (generation == readyGeneration) releaseHeldEvents()
            current?.let { postHistory(it) }
            // Turns running in other sessions too, so the UI keeps their delete buttons disabled.
            for (sessionId in activeTurns.toList()) {
                if (sessionId != current) post(turnState(sessionId, true))
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            post(sessionListMessage(emptyList(), current))
            if (e is CoreNotRunning || e is CoreCrashed) readyFailed = true
            if (generation == readyGeneration) releaseHeldEvents()
            if (e !is CoreCrashed) postError("LocalPilot core is not available: ${errorMessage(e)}")
        }
        val known = status ?: try {
            (core.request("ollama/status", JsonObject(emptyMap())) as? JsonObject)?.also { status = it }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        known?.let { post(withType("status", it)) }
        postActiveFile(force = true)
    }

    private suspend fun send(message: String, attachments: JsonArray) {
        var sessionId = current
        if (sessionId == null) {
            try {
                sessionId = newSessionId()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The UI is already showing a pending reply; end it (no session yet, so the UI accepts "").
                post(done(current ?: "", "error"))
                postError("Could not start a chat session: ${errorMessage(e)}")
                return
            }
            current = sessionId
            // Announce the session before any of its turn events arrive.
            try {
                postSessionList()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                post(sessionListMessage(sessions, sessionId))
            }
        }
        startTurn(sessionId)
        try {
            core.request("chat/send", buildJsonObject {
                put("sessionId", sessionId)
                put("message", message)
                put("attachments", attachments)
            })
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is RpcException && e.error.code == INVALID_PARAMS) {
                // That session's previous turn is still running; it will end with its own chat/done.
                postError("A reply is still in progress in this session. Wait for it or press Stop.")
                return
            }
            if (e is CoreCrashed) return // reported by the state handler
            val wasRunning = endTurn(sessionId)
            // The core stopped (e.g. a settings restart) and the state handler already ended this turn and said so.
            if (!wasRunning && e is CoreNotRunning) return
            if (wasRunning) post(done(sessionId, "error"))
            postError("Could not send the message: ${errorMessage(e)}")
        }
    }

    private suspend fun approve(msg: JsonObject) {
        val toolCallId = msg.str("toolCallId") ?: ""
        val sessionId = toolCallSessions[toolCallId] ?: current ?: return
        val params = buildJsonObject {
            put("sessionId", sessionId)
            put("toolCallId", toolCallId)
            put("decision", msg["decision"] ?: JsonNull)
            // editedArgs is already the complete args object (the core replaces args wholesale): pass it through untouched.
            msg["editedArgs"]?.let { put("editedArgs", it) }
        }
        core.request("chat/approve", params)
        // Decided (and the core took it): never offer it again after a history replay.
        pendingCalls[sessionId]?.remove(toolCallId)
    }

    private suspend fun switchSession(sessionId: String) {
        current = sessionId
        post(sessionListMessage(sessions, sessionId))
        postHistory(sessionId)
    }

    private suspend fun newSessionInternal() {
        try {
            val sessionId = newSessionId()
            current = sessionId
            postSessionList()
            post(buildJsonObject {
                put("type", "session/history")
                put("sessionId", sessionId)
                put("messages", JsonArray(emptyList()))
            })
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            postError("Could not start a new session: ${errorMessage(e)}")
        }
    }

    /**
     * Core `chat/deleteSession`. On success the UI gets `session/deleted { sessionId, next }` (next = the most recent
     * remaining session) and then the refreshed `session/list`; if the core refuses because the session's turn is
     * running it gets a `ui/error` saying so.
     */
    private suspend fun deleteSessionInternal(sessionId: String): String? {
        try {
            core.request("chat/deleteSession", buildJsonObject { put("sessionId", sessionId) })
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The core answers -32602 both for a running turn ("turn running …") and for an invalid id.
            val running = e is RpcException && e.error.code == INVALID_PARAMS && TURN_RUNNING.containsMatchIn(e.error.message)
            val message = if (running) {
                "That chat session's reply is still running. Wait for it or press Stop, then delete it."
            } else {
                "Could not delete the chat session: ${errorMessage(e)}"
            }
            if (e !is CoreCrashed) postError(message)
            return message
        }
        forgetSession(sessionId)
        val remaining = fetchSessionsOrNull() ?: sessions.filter { it.str("sessionId") != sessionId }
        val next = remaining.firstOrNull { it.str("sessionId") != sessionId }?.str("sessionId")
        if (current == sessionId) current = next
        post(buildJsonObject {
            put("type", "session/deleted")
            put("sessionId", sessionId)
            put("next", next?.let(::JsonPrimitive) ?: JsonNull)
        })
        sessions = remaining
        post(sessionListMessage(remaining, current))
        return null
    }

    /**
     * Core `chat/clearSessions`: one `session/deleted` per deleted session (next = the most recent survivor, i.e. a
     * session whose turn is running, or null), a notice for the kept ones, then the refreshed `session/list`.
     */
    private suspend fun clearSessionsInternal(): Pair<List<String>, List<String>> {
        val before = fetchSessionsOrNull() ?: sessions
        val skipped = try {
            val result = core.request("chat/clearSessions", JsonObject(emptyMap())) as? JsonObject
            (result?.get("skipped") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e !is CoreCrashed) postError("Could not clear the chat sessions: ${errorMessage(e)}")
            throw e
        }
        val after = fetchSessionsOrNull() ?: before.filter { it.str("sessionId") in skipped }
        val survivors = after.mapNotNull { it.str("sessionId") }.toSet()
        val deleted = before.mapNotNull { it.str("sessionId") }.filter { it !in survivors }
        val next = after.firstOrNull()?.str("sessionId")
        for (id in deleted) {
            forgetSession(id)
            if (current == id) current = next
            post(buildJsonObject {
                put("type", "session/deleted")
                put("sessionId", id)
                put("next", next?.let(::JsonPrimitive) ?: JsonNull)
            })
        }
        if (skipped.isNotEmpty()) {
            val n = skipped.size
            postError("$n session${if (n == 1) "" else "s"} with a running reply ${if (n == 1) "was" else "were"} kept.")
        }
        sessions = after
        post(sessionListMessage(after, current))
        return deleted to skipped
    }

    // ------------------------------------------------------------ models, settings, stats

    /** `models/list`: core `ollama/models` + the configured choices; `ollama: "down"` with `error` when that fails. */
    private suspend fun postModelsInternal() {
        if (ui == null) return
        val msg = try {
            val models = fetchModels()
            // Ollama answered, so a stale "down" status no longer applies; "modelMissing" still does.
            val ollama = if (status?.str("ollama") == "modelMissing") "modelMissing" else "ok"
            modelsMessage(models, ollama, null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            modelsMessage(JsonArray(emptyList()), "down", errorMessage(e))
        }
        post(msg)
    }

    private fun modelsMessage(models: JsonArray, ollama: String, error: String?): JsonObject {
        val s = settings.read()
        return buildJsonObject {
            put("type", "models/list")
            put("models", models)
            put("current", buildJsonObject {
                put("chat", s.chatModel)
                put("completion", s.completionModel)
            })
            put("ollama", ollama)
            if (error != null) put("error", error)
        }
    }

    private suspend fun fetchModels(): JsonArray {
        val result = core.request("ollama/models", JsonObject(emptyMap())) as? JsonObject
        val models = result?.get("models") as? JsonArray ?: JsonArray(emptyList())
        lastKnownModels = models
        return models
    }

    /**
     * `model/select`: writes the chat/completion model setting (the core restarts), then always answers `models/list`.
     * Only a name from the last-known installed list (fetched first if there is none yet) or the current setting is
     * written — the page is not trusted to name arbitrary models.
     */
    private suspend fun selectModel(kind: JsonElement?, name: JsonElement?) {
        val k = (kind as? JsonPrimitive)?.takeIf { it.isString }?.content
        val model = (name as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim().orEmpty()
        if ((k == "chat" || k == "completion") && model.isNotEmpty()) {
            if (isSelectable(k, model)) {
                try {
                    settings.write { if (k == "chat") it.chatModel = model else it.completionModel = model }
                } catch (e: Exception) {
                    postError("Could not save the $k model: ${errorMessage(e)}")
                }
            } else {
                postError("Model \"$model\" is not installed in Ollama.")
            }
        }
        postModelsInternal()
    }

    private suspend fun isSelectable(kind: String, model: String): Boolean {
        val s = settings.read()
        if ((if (kind == "chat") s.chatModel else s.completionModel) == model) return true
        val known = lastKnownModels ?: try {
            fetchModels()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        return known?.any { (it as? JsonObject)?.str("name") == model } ?: false
    }

    private fun postSettings() {
        val s = settings.read()
        post(buildJsonObject {
            put("type", "settings/current")
            put("settings", buildJsonObject {
                put("completionModel", s.completionModel)
                put("completionMaxTokens", s.completionMaxTokens)
                put("completionDebounceMs", s.completionDebounceMs)
                put("completionContextTokens", s.completionContextTokens)
                put("adaptiveCompletions", s.adaptiveCompletions)
            })
        })
    }

    /** `settings/set { patch }`: writes the panel's keys (others are ignored), then always answers `settings/current`. */
    private fun applySettings(patch: JsonElement?) {
        val writes = settingsWrites(patch)
        if (writes.isNotEmpty()) {
            try {
                settings.write { s -> for (w in writes) w(s) }
            } catch (e: Exception) {
                postError("Could not save the settings: ${errorMessage(e)}")
            }
        }
        postSettings()
    }

    private suspend fun postStats() {
        val stats = core.request("completion/stats", JsonObject(emptyMap()))
        post(buildJsonObject {
            put("type", "completion/stats")
            put("stats", stats)
        })
    }

    // ------------------------------------------------------------ core → UI

    private suspend fun onCoreNotification(method: String, params: JsonElement) {
        val p = params as? JsonObject ?: JsonObject(emptyMap())
        val sessionId = p.str("sessionId")
        val toolCallId = p.str("toolCallId")
        when (method) {
            "status" -> status = p
            "chat/toolCall" -> if (sessionId != null && toolCallId != null) {
                toolCallSessions[toolCallId] = sessionId
                if ((p["requiresApproval"] as? JsonPrimitive)?.booleanOrNull == true) {
                    pendingCalls.getOrPut(sessionId) { LinkedHashMap() }[toolCallId] = p
                }
            }
            "chat/toolResult" -> if (sessionId != null && toolCallId != null) pendingCalls[sessionId]?.remove(toolCallId)
            "chat/done" -> if (sessionId != null) {
                endTurn(sessionId)
                pendingCalls.remove(sessionId)
                toolCallSessions.values.removeAll { it == sessionId }
            }
        }
        val msg = withType(method, p)
        val held = heldEvents
        if (held != null && method != "status") held += msg else post(msg)
        // A finished turn may have titled the session: refresh the switcher (sessions are listed most recent first).
        if (method == "chat/done") {
            try {
                postSessionList()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
    }

    private suspend fun onCoreState(state: CoreState) {
        val previous = lastState
        lastState = state
        if (state != CoreState.READY) {
            failActiveTurns("The LocalPilot core stopped during the reply" + if (state == CoreState.STARTING) "; it is restarting." else ".")
        } else if (previous != null && previous != CoreState.READY) {
            // A (re)started core: refresh the Ollama status it reports.
            try {
                (core.request("ollama/status", JsonObject(emptyMap())) as? JsonObject)?.let {
                    status = it
                    post(withType("status", it))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
            // The page asked while the core was down and got an empty list: answer it again now.
            if (readyFailed && ui != null) onReady()
        }
    }

    /** Ends every turn the UI is waiting on with an error (the core died or was restarted). */
    private fun failActiveTurns(message: String) {
        if (activeTurns.isEmpty()) return
        val ended = activeTurns.toList()
        activeTurns.clear()
        toolCallSessions.clear()
        pendingCalls.clear()
        onChatActiveChanged(false)
        for (sessionId in ended) post(done(sessionId, "error"))
        postError(message)
    }

    // ------------------------------------------------------------ helpers

    private suspend fun <T> onBridge(block: suspend () -> T): T {
        val dispatcher = scope.coroutineContext[ContinuationInterceptor] ?: return block()
        return withContext(dispatcher) { block() }
    }

    private suspend fun newSessionId(): String {
        val result = core.request("chat/newSession", JsonObject(emptyMap())) as? JsonObject
        return result?.str("sessionId") ?: throw IllegalStateException("the core returned no session id")
    }

    private suspend fun fetchSessions(): List<JsonObject> {
        val result = core.request("chat/listSessions", JsonObject(emptyMap())) as? JsonObject
        return (result?.get("sessions") as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()
    }

    private suspend fun fetchSessionsOrNull(): List<JsonObject>? = try {
        fetchSessions()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    private suspend fun postSessionList() {
        val list = fetchSessions()
        sessions = list
        if (current == null) current = list.firstOrNull()?.str("sessionId")
        post(sessionListMessage(list, current))
    }

    private suspend fun postHistory(sessionId: String) {
        val result = core.request("chat/history", buildJsonObject { put("sessionId", sessionId) }) as? JsonObject
        if (current != sessionId) return // switched again meanwhile
        post(buildJsonObject {
            put("type", "session/history")
            put("sessionId", sessionId)
            put("messages", result?.get("messages") as? JsonArray ?: JsonArray(emptyList()))
        })
        // History shows tool calls as settled: re-offer those still awaiting a decision,
        // and tell the UI whether this session's turn is still running (Stop).
        for (call in pendingCalls[sessionId]?.values?.toList().orEmpty()) post(withType("chat/toolCall", call))
        post(turnState(sessionId, sessionId in activeTurns))
    }

    private fun releaseHeldEvents() {
        val held = heldEvents ?: return
        heldEvents = null
        for (msg in held) post(msg)
    }

    /** Drops the per-session bookkeeping for a deleted session. */
    private fun forgetSession(sessionId: String) {
        pendingCalls.remove(sessionId)
        toolCallSessions.values.removeAll { it == sessionId }
        if (endTurn(sessionId)) post(done(sessionId, "stopped"))
    }

    private fun startTurn(sessionId: String) {
        val wasIdle = activeTurns.isEmpty()
        activeTurns += sessionId
        if (wasIdle) onChatActiveChanged(true)
    }

    /** Forgets [sessionId]'s turn; true if it was running. */
    private fun endTurn(sessionId: String): Boolean {
        if (!activeTurns.remove(sessionId)) return false
        if (activeTurns.isEmpty()) onChatActiveChanged(false)
        return true
    }

    /**
     * Attachments from the page, kept only if they name a document the core syncs; a malformed range is dropped,
     * the attachment kept.
     */
    private fun validAttachments(raw: JsonElement?): JsonArray {
        val list = raw as? JsonArray ?: return JsonArray(emptyList())
        return JsonArray(list.mapNotNull { a ->
            val obj = a as? JsonObject ?: return@mapNotNull null
            val uri = obj.str("uri") ?: return@mapNotNull null
            if (!editors.isAttachable(uri)) return@mapNotNull null
            val range = obj["range"]
            buildJsonObject {
                put("uri", uri)
                if (range != null && isRange(range)) put("range", range)
            }
        })
    }

    private suspend fun postActiveFile(force: Boolean) {
        val file = try {
            editors.activeFile()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        val msg = buildJsonObject {
            put("type", "ui/activeFile")
            put("uri", file?.uri?.let(::JsonPrimitive) ?: JsonNull)
            if (file != null) {
                put("selection", buildJsonObject {
                    put("start", position(file.start))
                    put("end", position(file.end))
                })
            }
        }
        if (!force && msg == lastActiveFile) return
        lastActiveFile = msg
        post(msg)
    }

    private fun postError(message: String) = post(buildJsonObject {
        put("type", "ui/error")
        put("message", message)
    })

    private fun post(message: JsonObject) {
        ui?.post(message)
    }

    companion object {
        /** Core notifications relayed to the UI as `{ type: <method>, ...params }`. */
        val RELAYED = listOf("chat/token", "chat/toolCall", "chat/toolResult", "chat/done", "status", "ollama/pullProgress")
        const val APPLY_EDIT = "workspace/applyEdit"
        const val RUN_COMMAND = "workspace/runCommand"
        const val INVALID_PARAMS = -32602
        private val TURN_RUNNING = Regex("turn running", RegexOption.IGNORE_CASE)
        private val JSON = Json { ignoreUnknownKeys = true }

        /** The settings panel's number settings and their minimums (the settings page's ranges). */
        val PANEL_NUMBERS = linkedMapOf("completionMaxTokens" to 1, "completionDebounceMs" to 0, "completionContextTokens" to 256)

        /**
         * The writes a `settings/set { patch }` makes: numbers rounded and clamped to their minimums, the boolean
         * `adaptiveCompletions`; every other key (including `completionModel`, set only via `model/select`) ignored.
         */
        fun settingsWrites(patch: JsonElement?): List<(LocalPilotSettingsState) -> Unit> {
            val p = patch as? JsonObject ?: return emptyList()
            val writes = mutableListOf<(LocalPilotSettingsState) -> Unit>()
            for ((key, min) in PANEL_NUMBERS) {
                val v = (p[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull ?: continue
                if (!v.isFinite()) continue
                val n = v.roundToLong().coerceIn(min.toLong(), Int.MAX_VALUE.toLong()).toInt()
                writes.add(when (key) {
                    "completionMaxTokens" -> { s: LocalPilotSettingsState -> s.completionMaxTokens = n }
                    "completionDebounceMs" -> { s: LocalPilotSettingsState -> s.completionDebounceMs = n }
                    else -> { s: LocalPilotSettingsState -> s.completionContextTokens = n }
                })
            }
            val adaptive = (p["adaptiveCompletions"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
            if (adaptive != null) writes.add { s -> s.adaptiveCompletions = adaptive }
            return writes
        }

        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun withType(type: String, params: JsonObject) = JsonObject(params + ("type" to JsonPrimitive(type)))

        private fun done(sessionId: String, stopReason: String) = buildJsonObject {
            put("type", "chat/done")
            put("sessionId", sessionId)
            put("stopReason", stopReason)
        }

        private fun turnState(sessionId: String, running: Boolean) = buildJsonObject {
            put("type", "chat/turnState")
            put("sessionId", sessionId)
            put("running", running)
        }

        private fun sessionListMessage(sessions: List<JsonObject>, current: String?) = buildJsonObject {
            put("type", "session/list")
            put("sessions", JsonArray(sessions))
            put("current", current?.let(::JsonPrimitive) ?: JsonNull)
        }

        private fun position(p: Position) = buildJsonObject {
            put("line", p.line)
            put("character", p.character)
        }

        private fun isPosition(p: JsonElement?): Boolean {
            val o = p as? JsonObject ?: return false
            return (o["line"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull != null &&
                (o["character"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull != null
        }

        private fun isRange(r: JsonElement): Boolean = r is JsonObject && isPosition(r["start"]) && isPosition(r["end"])

        private fun errorMessage(e: Throwable): String = e.message ?: e.toString()
    }
}
