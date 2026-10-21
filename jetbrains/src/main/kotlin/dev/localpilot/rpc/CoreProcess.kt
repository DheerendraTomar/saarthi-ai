package dev.localpilot.rpc

import com.intellij.openapi.Disposable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.IOException
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

enum class CoreState { STOPPED, STARTING, READY, CRASHED }

enum class CoreLogLevel { DEBUG, INFO, WARN, ERROR }

/** How to launch the core; the client appends `serve --workspace <root> --log-level <level>`. */
data class CoreCommand(val command: List<String>, val env: Map<String, String> = emptyMap())

@Serializable
data class Capabilities(val completion: Boolean = false, val chat: Boolean = false, val bench: Boolean = false)

/** `{ ollama: "ok" | "down" | "modelMissing", detail }` — the `status` notification shape too. */
@Serializable
data class OllamaStatus(val ollama: String, val detail: String = "")

@Serializable
data class InitializeResult(
    val capabilities: Capabilities,
    val ollamaStatus: OllamaStatus,
    /** "building" or "ready". */
    val indexStatus: String,
)

/** Thrown to every request that was pending when the core process died unexpectedly. */
class CoreCrashed(val exitCode: Int?) : Exception("LocalPilot core exited unexpectedly (exit code $exitCode)")

/** Thrown by [CoreProcess.request] when no core is running (stopped, crashed past the restart limit, or stopping). */
class CoreNotRunning(message: String) : IllegalStateException(message)

/** An error response from the core (or, from an [CoreProcess.onRequest] handler, the error to answer with). */
class RpcException(val error: RpcError) : Exception(error.message) {
    constructor(code: Int, message: String) : this(RpcError(code, message))
}

/**
 * Owns one `localpilot-core serve` child process: newline-delimited JSON-RPC over its stdio,
 * restart-on-crash (at most [maxRestartsPerMinute] in any 60 s window, then [CoreState.CRASHED]),
 * and graceful [stop]. Mirrors `vscode/src/rpc/coreClient.ts`.
 *
 * - [command], [initSettings] and [logLevel] are read on every launch, so a [restart] picks up new settings.
 * - Notification handlers run on the stdout reader coroutine, in arrival order — keep them short (hand
 *   UI work to the EDT). Request handlers ([onRequest]) run in their own coroutine on [scope].
 * - Handlers survive restarts. Notifications sent while starting are queued until `initialize` has
 *   been answered (the core drops earlier ones); while stopped/crashed they are dropped.
 */
class CoreProcess(
    private val scope: CoroutineScope,
    /** The project folder; null (no folder open) → the core is never launched and [start] fails with [CoreNotRunning]. */
    private val workspace: Path?,
    private val command: () -> CoreCommand,
    private val initSettings: () -> JsonObject,
    private val logLevel: () -> String,
    private val log: (CoreLogLevel, String) -> Unit,
    private val maxRestartsPerMinute: Int = 3,
    private val shutdownTimeoutMs: Long = 2000,
) {
    /**
     * Called (non-suspending) when a [request] is abandoned because its coroutine was cancelled.
     * The default tells the core to stop generating for `completion/request` (`completion/cancel { requestId }`).
     */
    var cancelHook: (method: String, params: JsonElement) -> Unit = { method, params ->
        if (method == COMPLETION_REQUEST) {
            val requestId = (params as? JsonObject)?.get("requestId")
            if (requestId != null) notify(COMPLETION_CANCEL, buildJsonObject { put("requestId", requestId) })
        }
    }

    private val _state = MutableStateFlow(CoreState.STOPPED)
    val state: StateFlow<CoreState> = _state.asStateFlow()

    private val lock = Any()
    private val stopMutex = Mutex()
    private var running: Running? = null
    private var ready: CompletableDeferred<InitializeResult>? = null
    private var stopping = false
    /** A spawn is in progress outside [lock] (between [beginLaunchLocked] and [spawn] installing [running]). */
    private var spawning = false
    /** Bumped by every launch and by stop/dispose; a spawn whose generation is stale kills its process. */
    private var generation = 0L
    private var disposed = false
    private val restarts = ArrayDeque<Long>()
    private val queued = mutableListOf<Pair<String, JsonElement>>()
    private val notificationHandlers = ConcurrentHashMap<String, CopyOnWriteArrayList<(JsonElement) -> Unit>>()
    private val requestHandlers = ConcurrentHashMap<String, suspend (JsonElement) -> JsonElement>()

    private inner class Running(val process: Process) {
        val pending = ConcurrentHashMap<Long, CompletableDeferred<JsonElement>>()
        val nextId = AtomicLong(0)
        val outgoing = Channel<String>(Channel.UNLIMITED)
        /** Completes with the exit code once the process exited, its stdout was drained and the exit was handled. */
        val exit = CompletableDeferred<Int>()

        /** Queues one line for stdin; false if stdin is already closed. */
        fun send(msg: RpcMessage): Boolean = outgoing.trySend(JsonRpc.encode(msg)).isSuccess

        /** Sends a request and awaits its raw result; on cancellation the pending entry is dropped. */
        suspend fun call(method: String, params: JsonElement): JsonElement {
            val id = nextId.incrementAndGet()
            val answer = CompletableDeferred<JsonElement>()
            pending[id] = answer
            if (!send(RpcMessage.Request(JsonPrimitive(id), method, params))) {
                pending.remove(id)
                throw CoreNotRunning("LocalPilot core stdin is closed")
            }
            try {
                return answer.await()
            } catch (e: CancellationException) {
                pending.remove(id)
                if (!answer.isCompleted) cancelHook(method, params)
                throw e
            }
        }

        fun rejectAll(error: Throwable) {
            for (id in pending.keys.toList()) pending.remove(id)?.completeExceptionally(error)
        }
    }

    /**
     * Spawns the core and sends `initialize`; returns its result. Coalesces with a core that is already
     * running or being spawned (never two children). Call from a background coroutine: the spawn runs on it.
     */
    suspend fun start(): InitializeResult {
        val launch = synchronized(lock) {
            if (running == null && !spawning) restarts.clear()
            beginLaunchLocked()
        }
        spawn(launch)
        return launch.ready.await()
    }

    /** Stops the running core (if any) and starts a fresh one, with the restart budget reset. Serialized with [stop]. */
    suspend fun restart(): InitializeResult {
        val launch = stopMutex.withLock {
            stopInternal()
            synchronized(lock) {
                restarts.clear()
                beginLaunchLocked()
            }.also { spawn(it) }
        }
        return launch.ready.await()
    }

    /**
     * Sends a request once the core is ready and decodes the result with [serializer].
     * Throws [RpcException] for an error response, [CoreCrashed] if the core dies first and
     * [CoreNotRunning] when no core is running. Cancelling the calling coroutine abandons the
     * request and runs [cancelHook].
     */
    suspend fun <T> request(method: String, params: JsonElement, serializer: DeserializationStrategy<T>): T =
        json.decodeFromJsonElement(serializer, requestJson(method, params))

    /** [request] returning the raw JSON result. */
    suspend fun requestJson(method: String, params: JsonElement = JsonNull): JsonElement {
        val (st, r) = synchronized(lock) { _state.value to ready }
        if (st == CoreState.STARTING && r != null) r.await()
        val target = synchronized(lock) { running.takeIf { _state.value == CoreState.READY && !stopping } }
            ?: throw CoreNotRunning("LocalPilot core is not running (state: ${_state.value})")
        return target.call(method, params)
    }

    /** Sends a notification: queued while starting, dropped (with a log line) when not running. Never throws. */
    fun notify(method: String, params: JsonElement = JsonNull) {
        synchronized(lock) {
            val r = running
            when {
                _state.value == CoreState.READY && r != null -> {
                    if (!r.send(RpcMessage.Notification(method, params))) log(CoreLogLevel.WARN, "dropped $method notification: core stdin is closed")
                }
                _state.value == CoreState.STARTING -> queued.add(method to params)
                else -> Unit
            }
        }
    }

    fun onNotification(method: String, handler: (JsonElement) -> Unit): Disposable {
        val list = notificationHandlers.computeIfAbsent(method) { CopyOnWriteArrayList() }
        list.add(handler)
        return Disposable { list.remove(handler) }
    }

    /**
     * Answers core→client requests (`workspace/applyEdit`, `workspace/runCommand`). One handler per method.
     * A handler's [RpcException] is answered as that error; any other exception as `-32603`.
     */
    fun onRequest(method: String, handler: suspend (JsonElement) -> JsonElement): Disposable {
        requestHandlers[method] = handler
        return Disposable { requestHandlers.remove(method, handler) }
    }

    /**
     * Sends `shutdown`, closes stdin, waits up to [shutdownTimeoutMs] in total for the process to exit,
     * then kills it. Returns the exit code, or null if nothing was running. Never auto-restarts afterwards.
     */
    suspend fun stop(): Int? = stopMutex.withLock { stopInternal() }

    /** Must be called holding [stopMutex]. */
    private suspend fun stopInternal(): Int? {
        val target = synchronized(lock) {
            val r = running
            if (r == null) {
                generation++ // a spawn in progress is discarded (its process killed)
                spawning = false
                ready?.completeExceptionally(CoreNotRunning("LocalPilot core stopped"))
                setState(CoreState.STOPPED)
            } else {
                stopping = true
            }
            r
        } ?: return null
        try {
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(shutdownTimeoutMs)
            withTimeoutOrNull(shutdownTimeoutMs) {
                try {
                    target.call("shutdown", JsonNull)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // the process exited (or stdin closed) first
                }
            }
            target.outgoing.close()
            val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).coerceAtLeast(0)
            return withTimeoutOrNull(remaining) { target.exit.await() } ?: run {
                log(CoreLogLevel.WARN, "LocalPilot core did not exit within $shutdownTimeoutMs ms of shutdown; killing it")
                target.process.destroyForcibly()
                withTimeoutOrNull(KILL_WAIT_MS) { target.exit.await() }
                    ?: target.process.takeIf { !it.isAlive }?.exitValue()
            }
        } finally {
            synchronized(lock) { stopping = false }
        }
    }

    /**
     * Non-suspending teardown for `Disposable.dispose()` (project close): sends `shutdown`, closes stdin
     * and kills the process if it has not exited [shutdownTimeoutMs] later.
     */
    fun dispose() {
        // Not under stopMutex (this must not suspend on the EDT): `disposed` stops any later or in-flight
        // launch, and a concurrent stop() only adds a second, harmless kill of the same process.
        val target = synchronized(lock) {
            disposed = true
            stopping = true
            generation++
            spawning = false
            running
        } ?: return
        target.pending[target.nextId.incrementAndGet().also {
            target.send(RpcMessage.Request(JsonPrimitive(it), "shutdown", JsonNull))
        }] = CompletableDeferred()
        target.outgoing.close()
        val process = target.process
        Thread({
            try {
                if (!process.waitFor(shutdownTimeoutMs, TimeUnit.MILLISECONDS)) process.destroyForcibly()
            } catch (_: InterruptedException) {
                process.destroyForcibly()
            }
        }, "LocalPilot core shutdown").apply { isDaemon = true }.start()
    }

    private class Launch(val generation: Long, val ready: CompletableDeferred<InitializeResult>, val isNew: Boolean)

    /**
     * Must be called holding [lock]. Reserves a launch (state STARTING, fresh `ready`) or, when a core is
     * already running or being spawned, returns that one's `ready` so callers coalesce. Does not spawn.
     */
    private fun beginLaunchLocked(): Launch {
        val current = ready
        if ((running != null || spawning) && current != null) return Launch(generation, current, isNew = false)
        if (disposed) {
            return Launch(generation, CompletableDeferred<InitializeResult>().apply { completeExceptionally(CoreNotRunning("LocalPilot core is disposed")) }, isNew = false)
        }
        queued.clear()
        setState(CoreState.STARTING)
        val ready = CompletableDeferred<InitializeResult>()
        this.ready = ready
        spawning = true
        generation++
        return Launch(generation, ready, isNew = true)
    }

    /** Spawns the process for a reserved [launch] — never under [lock], so notify() is never blocked by a spawn. */
    private fun spawn(launch: Launch) {
        if (!launch.isNew) return
        val ws = workspace
        val process = try {
            if (ws == null) throw CoreNotRunning("LocalPilot needs a project folder: open a folder to start the core.")
            val cmd = command()
            val argv = cmd.command + listOf("serve", "--workspace", ws.toString(), "--log-level", logLevel())
            ProcessBuilder(argv).directory(ws.toFile()).apply { environment().putAll(cmd.env) }.start()
        } catch (e: Exception) {
            // No folder / missing or non-executable binary: retrying is pointless.
            log(CoreLogLevel.ERROR, "LocalPilot core could not be started: ${e.message}")
            synchronized(lock) {
                if (generation == launch.generation) {
                    spawning = false
                    setState(CoreState.CRASHED)
                }
            }
            launch.ready.completeExceptionally(e)
            return
        }
        val r = Running(process)
        val installed = synchronized(lock) {
            if (generation == launch.generation && !disposed) {
                spawning = false
                running = r
                true
            } else {
                false
            }
        }
        if (!installed) {
            // stop()/dispose() ran while we were spawning: this child must not outlive it.
            process.destroyForcibly()
            launch.ready.completeExceptionally(CoreNotRunning("LocalPilot core stopped"))
            return
        }
        val ready = launch.ready

        // Writer: the only code that touches stdin. Closing `outgoing` closes stdin after the queue drains.
        scope.launch(Dispatchers.IO) {
            val stdin = process.outputStream.bufferedWriter(Charsets.UTF_8)
            try {
                for (line in r.outgoing) {
                    stdin.write(line)
                    stdin.write("\n")
                    stdin.flush()
                }
            } catch (e: IOException) {
                log(CoreLogLevel.WARN, "LocalPilot core stdin closed: ${e.message}")
            } finally {
                r.outgoing.close()
                try {
                    stdin.close()
                } catch (_: IOException) {
                }
            }
        }
        // Always drain stderr so a chatty core can never block on a full pipe.
        scope.launch(Dispatchers.IO) {
            try {
                process.errorStream.bufferedReader(Charsets.UTF_8).forEachLine { if (it.isNotBlank()) log(CoreLogLevel.DEBUG, it) }
            } catch (_: IOException) {
            }
        }
        // Reader: dispatches every line; the exit is handled only after stdout is drained, so no response is lost.
        scope.launch(Dispatchers.IO) {
            try {
                process.inputStream.bufferedReader(Charsets.UTF_8).forEachLine { receive(r, it) }
            } catch (_: IOException) {
            }
            val code = runInterruptible { process.waitFor() }
            handleExit(r, code)
            r.exit.complete(code)
        }

        scope.launch {
            try {
                val raw = r.call("initialize", buildJsonObject {
                    put("workspaceRoot", ws.toString())
                    put("settings", initSettings())
                })
                val result = json.decodeFromJsonElement(InitializeResult.serializer(), raw)
                synchronized(lock) {
                    if (running === r && _state.value == CoreState.STARTING) {
                        setState(CoreState.READY)
                        for ((method, params) in queued) r.send(RpcMessage.Notification(method, params))
                        queued.clear()
                    }
                }
                ready.complete(result)
            } catch (e: RpcException) {
                // The core is alive but refused to initialize: restarting would not help.
                synchronized(lock) {
                    if (running === r) {
                        log(CoreLogLevel.ERROR, "LocalPilot core refused initialize: ${e.message}")
                        running = null
                        setState(CoreState.CRASHED)
                        r.outgoing.close()
                        process.destroy()
                    }
                }
                ready.completeExceptionally(e)
            } catch (e: Throwable) {
                ready.completeExceptionally(e)
            }
        }
    }

    private fun handleExit(r: Running, code: Int) {
        // Pending callers are failed last, so when they resume the state already says what happens next.
        var relaunch: Launch? = null
        val error: Throwable = synchronized(lock) {
            r.outgoing.close()
            if (running !== r) return@synchronized CoreNotRunning("LocalPilot core stopped")
            running = null
            queued.clear()
            if (stopping) {
                setState(CoreState.STOPPED)
                return@synchronized CoreNotRunning("LocalPilot core stopped")
            }
            val now = System.currentTimeMillis()
            while (restarts.isNotEmpty() && now - restarts.first() >= RESTART_WINDOW_MS) restarts.removeFirst()
            if (restarts.size >= maxRestartsPerMinute) {
                setState(CoreState.CRASHED)
                log(
                    CoreLogLevel.ERROR,
                    "LocalPilot core crashed (exit code $code) after $maxRestartsPerMinute restarts within a minute; not restarting. " +
                        "See <project>/.localpilot/core.log, then restart the core.",
                )
            } else {
                restarts.addLast(now)
                log(CoreLogLevel.WARN, "LocalPilot core exited unexpectedly (exit code $code); restarting (${restarts.size}/$maxRestartsPerMinute this minute)")
                relaunch = beginLaunchLocked()
            }
            CoreCrashed(code)
        }
        r.rejectAll(error)
        relaunch?.let { spawn(it) }
    }

    private fun receive(r: Running, line: String) {
        when (val msg = JsonRpc.decode(line)) {
            null -> if (line.isNotBlank()) log(CoreLogLevel.WARN, "ignored a malformed line from the core: ${line.take(200)}")
            is RpcMessage.Response -> {
                val id = msg.id.longOrNull
                val answer = id?.let { r.pending.remove(it) }
                when {
                    answer == null -> log(CoreLogLevel.WARN, "response for unknown request id ${msg.id}")
                    msg.error != null -> answer.completeExceptionally(RpcException(msg.error))
                    else -> answer.complete(msg.result ?: JsonNull)
                }
            }
            is RpcMessage.Notification -> {
                for (handler in notificationHandlers[msg.method].orEmpty()) {
                    try {
                        handler(msg.params)
                    } catch (e: Exception) {
                        log(CoreLogLevel.ERROR, "handler for ${msg.method} threw: ${e.message}")
                    }
                }
            }
            is RpcMessage.Request -> scope.launch {
                val handler = requestHandlers[msg.method]
                val response = if (handler == null) {
                    RpcMessage.Response(msg.id, error = RpcError(METHOD_NOT_FOUND, "method not found: ${msg.method}"))
                } else {
                    try {
                        RpcMessage.Response(msg.id, result = handler(msg.params))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: RpcException) {
                        RpcMessage.Response(msg.id, error = e.error)
                    } catch (e: Exception) {
                        RpcMessage.Response(msg.id, error = RpcError(INTERNAL_ERROR, e.message ?: e.toString()))
                    }
                }
                r.send(response)
            }
        }
    }

    private fun setState(state: CoreState) {
        _state.value = state
    }

    companion object {
        const val COMPLETION_REQUEST = "completion/request"
        const val COMPLETION_CANCEL = "completion/cancel"
        const val METHOD_NOT_FOUND = -32601
        const val INTERNAL_ERROR = -32603
        private const val RESTART_WINDOW_MS = 60_000L
        /** How long stop() waits for a killed process to be reaped. */
        private const val KILL_WAIT_MS = 5_000L
        private val json = Json { ignoreUnknownKeys = true }
    }
}
