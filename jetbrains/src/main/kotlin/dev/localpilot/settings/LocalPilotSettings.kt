package dev.localpilot.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.options.BoundSearchableConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.COLUMNS_LARGE
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.dsl.builder.rows
import com.intellij.util.messages.Topic
import dev.localpilot.rpc.CoreCommand
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import java.nio.file.Files
import java.nio.file.Path

/**
 * The LocalPilot settings: same keys and defaults as the core (`core/src/settings.rs`) and VS Code
 * (`vscode/package.json` `contributes.configuration`). Sent whole as `initialize.settings` (see
 * [coreInitSettings]); `coreBinaryPath` and `logLevel` also configure how the core is launched.
 */
@Serializable
data class LocalPilotSettingsState(
    var ollamaUrl: String = "http://localhost:11434",
    var completionModel: String = "qwen2.5-coder:0.5b-base",
    var chatModel: String = "qwen3.8:27b-mlx",
    var completionsEnabled: Boolean = true,
    var completionDebounceMs: Int = 120,
    var completionMaxTokens: Int = 32,
    /** "off" | "on" */
    var chatThinking: String = "off",
    var coreBinaryPath: String = "",
    var allowedCommandsAlways: MutableList<String> = mutableListOf(),
    var completionContextTokens: Int = 3584,
    var chatContextTokens: Int = 24000,
    /** "error" | "warn" | "info" | "debug" | "trace" */
    var logLevel: String = "info",
    /** Let the core adapt completion length and add style examples from past outcomes. */
    var adaptiveCompletions: Boolean = true,
) {
    /** A deep copy (the list is not shared). */
    fun snapshot(): LocalPilotSettingsState = copy(allowedCommandsAlways = allowedCommandsAlways.toMutableList())
}

private val settingsJson = Json { encodeDefaults = true }

/**
 * The settings sent in `initialize`. Completions are always enabled in the core (it would otherwise
 * answer empty until restarted); the inline provider gates them on [LocalPilotSettingsState.completionsEnabled],
 * so toggling needs no restart. Same as the VS Code and JupyterLab clients.
 */
fun coreInitSettings(s: LocalPilotSettingsState): JsonObject {
    val obj = settingsJson.encodeToJsonElement(s).jsonObject
    return JsonObject(obj + ("completionsEnabled" to JsonPrimitive(true)))
}

/** Settings the client applies itself; changing only these does not restart the core. */
val CLIENT_ONLY_SETTINGS = setOf("completionsEnabled", "completionDebounceMs")

/** True when [a] and [b] differ only in [CLIENT_ONLY_SETTINGS] (so the running core can be kept). */
fun sameCoreSettings(a: LocalPilotSettingsState, b: LocalPilotSettingsState): Boolean =
    settingsJson.encodeToJsonElement(a).jsonObject - CLIENT_ONLY_SETTINGS ==
        settingsJson.encodeToJsonElement(b).jsonObject - CLIENT_ONLY_SETTINGS

class CoreBinaryNotFound(message: String) : Exception(message)

/** Rust target triple of the bundled core for this OS/arch (`os.name` / `os.arch` values), if we ship one. */
fun targetTriple(osName: String, osArch: String): String? {
    val os = osName.lowercase()
    val arm = osArch == "aarch64" || osArch == "arm64"
    val x64 = osArch == "amd64" || osArch == "x86_64"
    return when {
        os.startsWith("mac") && arm -> "aarch64-apple-darwin"
        os.startsWith("mac") && x64 -> "x86_64-apple-darwin"
        os.startsWith("linux") && x64 -> "x86_64-unknown-linux-gnu"
        os.startsWith("linux") && arm -> "aarch64-unknown-linux-gnu"
        os.startsWith("windows") && x64 -> "x86_64-pc-windows-msvc"
        else -> null
    }
}

/**
 * How to launch the core: the `coreBinaryPath` setting if set (it must exist), else the bundled
 * `<pluginRoot>/lib/bin/<triple>/localpilot-core`; otherwise throws [CoreBinaryNotFound] saying how to fix it.
 */
fun resolveBinaryPath(
    settings: LocalPilotSettingsState,
    pluginRoot: Path?,
    osName: String = System.getProperty("os.name"),
    osArch: String = System.getProperty("os.arch"),
    exists: (Path) -> Boolean = { Files.isRegularFile(it) },
): CoreCommand {
    val override = settings.coreBinaryPath.trim()
    if (override.isNotEmpty()) {
        if (!exists(Path.of(override))) {
            throw CoreBinaryNotFound(
                "LocalPilot: the coreBinaryPath setting points to \"$override\", which does not exist. " +
                    "Fix the path or clear the setting to use the bundled core.",
            )
        }
        return CoreCommand(listOf(override))
    }
    val triple = targetTriple(osName, osArch)
    val exe = if (osName.lowercase().startsWith("windows")) "localpilot-core.exe" else "localpilot-core"
    val bundled = if (triple != null && pluginRoot != null) pluginRoot.resolve("lib/bin/$triple/$exe") else null
    if (bundled != null && exists(bundled)) return CoreCommand(listOf(bundled.toString()))
    throw CoreBinaryNotFound(
        "LocalPilot: Core binary not found for $osName/$osArch" + (bundled?.let { " (looked for $it)" } ?: "") +
            ". Build it with scripts/build-core.sh, or set Settings → Tools → LocalPilot → coreBinaryPath.",
    )
}

/** Published on the application message bus after the settings changed. */
fun interface LocalPilotSettingsListener {
    fun settingsChanged(old: LocalPilotSettingsState, new: LocalPilotSettingsState)
}

@Service(Service.Level.APP)
@State(name = "LocalPilotSettings", storages = [Storage("localpilot.xml")])
class LocalPilotSettings : PersistentStateComponent<LocalPilotSettingsState> {
    @Volatile
    private var current = LocalPilotSettingsState()

    /** A snapshot of the current settings (mutating it changes nothing; use [update]). */
    override fun getState(): LocalPilotSettingsState = current.snapshot()

    override fun loadState(state: LocalPilotSettingsState) {
        current = state.snapshot()
    }

    /** Replaces the settings and notifies [TOPIC] subscribers if anything changed. */
    fun update(new: LocalPilotSettingsState) {
        val old = current
        if (old == new) return
        current = new.snapshot()
        ApplicationManager.getApplication().messageBus.syncPublisher(TOPIC).settingsChanged(old.snapshot(), new.snapshot())
    }

    companion object {
        @JvmField
        val TOPIC: Topic<LocalPilotSettingsListener> = Topic.create("LocalPilot settings", LocalPilotSettingsListener::class.java)

        fun getInstance(): LocalPilotSettings = service()
    }
}

/** Settings → Tools → LocalPilot. */
class LocalPilotConfigurable : BoundSearchableConfigurable("LocalPilot", "dev.localpilot.settings") {
    private var draft = LocalPilotSettings.getInstance().state

    override fun createPanel(): DialogPanel = panel {
        group("Ollama") {
            row("Ollama URL:") {
                textField().bindText({ draft.ollamaUrl }, { draft.ollamaUrl = it.trim() }).columns(COLUMNS_LARGE)
                    .comment("Base URL of the local Ollama server. LocalPilot talks to nothing else.")
            }
        }
        group("Inline Completions") {
            row {
                checkBox("Show inline (ghost text) completions")
                    .bindSelected({ draft.completionsEnabled }, { draft.completionsEnabled = it })
            }
            row("Completion model:") {
                textField().bindText({ draft.completionModel }, { draft.completionModel = it.trim() }).columns(COLUMNS_LARGE)
                    .comment("Small fill-in-the-middle model (qwen2.5-coder:1.5b-base is the higher-quality alternative).")
            }
            row("Debounce (ms):") {
                intTextField(0..60_000).bindIntText({ draft.completionDebounceMs }, { draft.completionDebounceMs = it })
            }
            row("Max tokens:") {
                intTextField(1..4096).bindIntText({ draft.completionMaxTokens }, { draft.completionMaxTokens = it })
            }
            row("Context tokens:") {
                intTextField(256..1_000_000).bindIntText({ draft.completionContextTokens }, { draft.completionContextTokens = it })
                    .comment("Total prompt budget (prefix + suffix + related snippets).")
            }
            row {
                checkBox("Adapt completion length and style to past accepts/rejects")
                    .bindSelected({ draft.adaptiveCompletions }, { draft.adaptiveCompletions = it })
            }
        }
        group("Chat") {
            row("Chat model:") {
                textField().bindText({ draft.chatModel }, { draft.chatModel = it.trim() }).columns(COLUMNS_LARGE)
            }
            row("Thinking:") {
                comboBox(listOf("off", "on")).bindItem({ draft.chatThinking }, { draft.chatThinking = it ?: "off" })
            }
            row("Context tokens:") {
                intTextField(1024..10_000_000).bindIntText({ draft.chatContextTokens }, { draft.chatContextTokens = it })
                    .comment("Chat history budget before older turns are dropped.")
            }
            row("Commands approved \"Always\":") {}
            row {
                textArea().rows(4).align(AlignX.FILL)
                    .bindText(
                        { draft.allowedCommandsAlways.joinToString("\n") },
                        { text -> draft.allowedCommandsAlways = text.lines().map { it.trim() }.filter { it.isNotEmpty() }.toMutableList() },
                    )
                    .comment("One per line; the agent runs these without asking.")
            }
        }
        group("Core") {
            row("Core binary:") {
                textField().bindText({ draft.coreBinaryPath }, { draft.coreBinaryPath = it.trim() }).columns(COLUMNS_LARGE)
                    .comment("Path to a localpilot-core binary that overrides the bundled one (empty = bundled).")
            }
            row("Log level:") {
                comboBox(listOf("error", "warn", "info", "debug", "trace"))
                    .bindItem({ draft.logLevel }, { draft.logLevel = it ?: "info" })
                    .comment("Core logs go to &lt;project&gt;/.localpilot/core.log.")
            }
        }
    }

    override fun reset() {
        draft = LocalPilotSettings.getInstance().state
        super.reset()
    }

    override fun apply() {
        super.apply()
        LocalPilotSettings.getInstance().update(draft.snapshot())
    }
}
