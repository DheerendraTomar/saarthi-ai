package dev.localpilot.chat

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Applies a core `workspace/applyEdit` request (params/result = `ApplyEditParams` / `ApplyEditResult` in
 * `core/src/protocol.rs`). Never throws: failures are returned as `{ applied: false, error }`. Implemented by Task 5c.
 */
interface EditApplier {
    suspend fun apply(params: JsonElement): JsonElement
}

/**
 * Runs a core `workspace/runCommand` request (`RunCommandParams` → `RunCommandResult { exitCode, stdout, stderr }`).
 * Never throws: failures are returned in the result. Implemented by Task 5c.
 */
interface CommandRunner {
    suspend fun run(params: JsonElement): JsonElement
}

/** The UI's "Start Ollama" / "Pull model" buttons. Implemented by Task 5d's StartOllama / PullModel actions. */
interface OllamaActions {
    /** Opens the IDE terminal running `ollama serve` (never started automatically). Called on the bridge's thread. */
    fun start()

    /**
     * Core `ollama/pull { model }` with a progress indicator; returns when the pull finished or failed.
     * Called on the bridge's single-threaded dispatcher: must suspend while waiting, never block.
     */
    suspend fun pull(model: String)
}

/**
 * What the chat bridge delegates to the rest of the plugin. The defaults answer "not available" so the core
 * always gets a well-formed reply before Task 5d wires the real implementations
 * (`ChatService.getInstance(project).installHooks(HostHooks(...))`).
 */
data class HostHooks(
    val edits: EditApplier = NotWired.edits,
    val commands: CommandRunner = NotWired.commands,
    val ollama: OllamaActions = NotWired.ollama,
) {
    private object NotWired {
        val edits = object : EditApplier {
            override suspend fun apply(params: JsonElement): JsonElement = buildJsonObject {
                put("applied", false)
                put("error", "LocalPilot: applying edits is not available in this IDE build")
            }
        }
        val commands = object : CommandRunner {
            override suspend fun run(params: JsonElement): JsonElement = buildJsonObject {
                put("exitCode", JsonPrimitive(-1))
                put("stdout", "")
                put("stderr", "LocalPilot: running commands is not available in this IDE build")
            }
        }
        val ollama = object : OllamaActions {
            override fun start() = Unit
            override suspend fun pull(model: String) = Unit
        }
    }
}
