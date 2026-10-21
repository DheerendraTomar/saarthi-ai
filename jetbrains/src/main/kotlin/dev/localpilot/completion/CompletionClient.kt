package dev.localpilot.completion

import dev.localpilot.rpc.CoreProcess
import dev.localpilot.rpc.CoreState
import dev.localpilot.sync.DocumentSink
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonElement

/**
 * The part of the core the inline provider uses (a fake in tests). Extends [DocumentSink] so one fake can
 * drive both the document sync and the provider.
 */
interface CompletionClient : DocumentSink {
    /**
     * Sends a request and returns its raw result. Contract (as [CoreProcess.requestJson] with its default
     * `cancelHook`): cancelling the caller of a `completion/request` notifies `completion/cancel { requestId }`
     * with the request's `requestId`. Throws when the core is not running or answers with an error.
     */
    suspend fun request(method: String, params: JsonElement): JsonElement
}

/** Production [CompletionClient]: the project's [CoreProcess]. */
class CoreCompletionClient(private val process: CoreProcess) : CompletionClient {
    override val state: StateFlow<CoreState> get() = process.state

    override fun notify(method: String, params: JsonElement) = process.notify(method, params)

    override suspend fun request(method: String, params: JsonElement): JsonElement = process.requestJson(method, params)
}
