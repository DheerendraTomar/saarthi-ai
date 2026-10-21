package dev.localpilot.actions

import dev.localpilot.settings.LocalPilotSettings
import dev.localpilot.settings.LocalPilotSettingsState
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

enum class ModelKind(val label: String) { CHAT("Chat"), COMPLETION("Completion") }

/** One installed model, as core `ollama/models` reports it (`OllamaModel` in `core/src/protocol.rs`). */
data class ModelInfo(
    val name: String,
    val sizeBytes: Long = 0,
    val family: String? = null,
    /** Fill-in-the-middle (`insert`): usable for inline completions. */
    val supportsInsert: Boolean = false,
    /** Tool calling: usable for agent chat. */
    val supportsTools: Boolean = false,
)

/** One row of the model picker. */
data class ModelChoice(val model: ModelInfo, val current: Boolean, val description: String, val hint: String, val warning: Boolean) {
    val text: String get() = buildString {
        append(model.name)
        if (description.isNotEmpty()) append("  ·  ").append(description)
        append("  —  ").append(hint)
    }
}

object Models {
    /** The `models` of an `ollama/models` result; malformed entries are skipped. */
    fun parse(result: JsonElement?): List<ModelInfo> {
        val list = (result as? JsonObject)?.get("models") as? JsonArray ?: return emptyList()
        return list.mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val name = (o["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            ModelInfo(
                name = name,
                sizeBytes = (o["sizeBytes"] as? JsonPrimitive)?.longOrNull ?: 0,
                family = (o["family"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() },
                supportsInsert = (o["supportsInsert"] as? JsonPrimitive)?.booleanOrNull ?: false,
                supportsTools = (o["supportsTools"] as? JsonPrimitive)?.booleanOrNull ?: false,
            )
        }
    }

    /** `986000000` → "986 MB", `17000000000` → "17.0 GB" (as VS Code). */
    fun formatSize(bytes: Long): String = when {
        bytes <= 0 -> ""
        bytes >= 1_000_000_000 -> String.format(java.util.Locale.ROOT, "%.1f GB", bytes / 1e9)
        else -> "${maxOf(1L, Math.round(bytes / 1e6))} MB"
    }

    /** Picker rows with size, family and the capability hint for [kind]; the current model is marked. */
    fun choices(models: List<ModelInfo>, kind: ModelKind, current: String): List<ModelChoice> = models.map { m ->
        val description = listOf(formatSize(m.sizeBytes), m.family.orEmpty()).filter { it.isNotEmpty() }.joinToString(" · ")
        val (hint, warning) = when (kind) {
            ModelKind.COMPLETION ->
                if (m.supportsInsert) "fill-in-the-middle" to false else "no fill-in-the-middle: inline completions will be poor" to true
            ModelKind.CHAT ->
                if (m.supportsTools) "tool calling" to false else "no tool calling: the agent cannot edit files or run commands" to true
        }
        ModelChoice(m, m.name == current, description, hint, warning)
    }

    fun current(state: LocalPilotSettingsState, kind: ModelKind): String =
        if (kind == ModelKind.CHAT) state.chatModel else state.completionModel

    /**
     * Writes the chat / completion model setting (a core-relevant setting: [dev.localpilot.rpc.LocalPilotCore] restarts
     * the core). Returns false when nothing changed.
     */
    fun select(kind: ModelKind, name: String, settings: LocalPilotSettings = LocalPilotSettings.getInstance()): Boolean {
        val model = name.trim()
        val state = settings.state
        if (model.isEmpty() || current(state, kind) == model) return false
        if (kind == ModelKind.CHAT) state.chatModel = model else state.completionModel = model
        settings.update(state)
        return true
    }
}

/** One language of `completion/stats` (`CompletionLanguageStats`). */
data class LanguageStats(
    val language: String,
    val served: Long,
    val accepted: Long,
    val partial: Long,
    val rejected: Long,
    val typedThrough: Long,
    val acceptRate: Double,
    val learnedMaxLines: Long,
    val learnedNumPredict: Long,
    val learned: Boolean,
    val examples: Long,
)

data class CompletionStats(val languages: List<LanguageStats>, val logPath: String?, val adaptive: Boolean) {
    companion object {
        fun parse(result: JsonElement?): CompletionStats {
            val o = result as? JsonObject ?: return CompletionStats(emptyList(), null, false)
            fun JsonObject.long(key: String) = (this[key] as? JsonPrimitive)?.longOrNull ?: 0
            val languages = (o["languages"] as? JsonObject).orEmpty().mapNotNull { (lang, v) ->
                val l = v as? JsonObject ?: return@mapNotNull null
                LanguageStats(
                    language = lang,
                    served = l.long("served"),
                    accepted = l.long("accepted"),
                    partial = l.long("partial"),
                    rejected = l.long("rejected"),
                    typedThrough = l.long("typedThrough"),
                    acceptRate = (l["acceptRate"] as? JsonPrimitive)?.doubleOrNull ?: 0.0,
                    learnedMaxLines = l.long("learnedMaxLines"),
                    learnedNumPredict = l.long("learnedNumPredict"),
                    learned = (l["learned"] as? JsonPrimitive)?.booleanOrNull ?: false,
                    examples = l.long("examples"),
                )
            }
            return CompletionStats(
                languages = languages,
                logPath = (o["logPath"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
                adaptive = (o["adaptive"] as? JsonPrimitive)?.booleanOrNull ?: false,
            )
        }
    }
}
