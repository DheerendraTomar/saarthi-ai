package dev.localpilot.chat

import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.ui.JBColor
import com.intellij.ui.scale.JBUIScale
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.NamedColorUtil
import com.intellij.util.ui.UIUtil
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.awt.Color
import javax.swing.UIManager
import kotlin.math.roundToInt

/**
 * IDE theme → chat-ui. The bundle styles itself from VS Code's `--vscode-*` custom properties
 * (`chat-ui/src/styles.css`); the JetBrains host maps the current Look-and-Feel and editor scheme onto those names,
 * injects them as a `<style>:root{…}</style>` when the page loads and sends `ui/theme` when the LAF or the editor
 * scheme changes. The `diffEditor-*` backgrounds have no IDE counterpart and keep the bundle's translucent defaults
 * (as in `jupyterlab/src/chat/theme.ts`).
 */
object ChatTheme {
    /** The `--vscode-*` values for the current IDE theme. Call on the EDT (reads Swing defaults and the editor scheme). */
    fun currentVars(): Map<String, String> {
        val scheme = EditorColorsManager.getInstance().globalScheme
        val editorBg = scheme.defaultBackground
        val fg = UIUtil.getLabelForeground()
        val panelBg = UIUtil.getPanelBackground()
        val border = JBColor.border()
        val inputBg = UIUtil.getTextFieldBackground()
        val inputFg = UIUtil.getTextFieldForeground()
        val focus = JBUI.CurrentTheme.Focus.focusColor()
        val error = NamedColorUtil.getErrorForeground()
        val success = JBColor(Color(0x36, 0x96, 0x50), Color(0x5F, 0xB8, 0x65))
        val warning = JBColor(Color(0xC2, 0x7D, 0x00), Color(0xE0, 0xA0, 0x3A))
        val buttonBg = ui("Button.default.startBackground") ?: ui("Button.default.background") ?: focus
        val buttonFg = ui("Button.default.foreground") ?: Color.WHITE
        val secondaryBg = ui("Button.startBackground") ?: ui("Button.background") ?: panelBg
        val secondaryFg = ui("Button.foreground") ?: fg
        val keyword = scheme.getAttributes(DefaultLanguageHighlighterColors.KEYWORD)?.foregroundColor ?: fg
        val labelFont = UIUtil.getLabelFont()
        val fontPx = (labelFont.size2D / JBUIScale.scale(1f)).roundToInt().coerceIn(8, 40)

        val colors = linkedMapOf(
            "--vscode-foreground" to fg,
            "--vscode-descriptionForeground" to NamedColorUtil.getInactiveTextColor(),
            "--vscode-sideBar-background" to panelBg,
            "--vscode-editor-background" to editorBg,
            "--vscode-panel-border" to border,
            "--vscode-widget-border" to border,
            "--vscode-input-background" to inputBg,
            "--vscode-input-foreground" to inputFg,
            "--vscode-input-border" to border,
            "--vscode-focusBorder" to focus,
            "--vscode-button-background" to buttonBg,
            "--vscode-button-foreground" to buttonFg,
            "--vscode-button-hoverBackground" to buttonBg,
            "--vscode-button-secondaryBackground" to secondaryBg,
            "--vscode-button-secondaryForeground" to secondaryFg,
            "--vscode-button-secondaryHoverBackground" to secondaryBg,
            "--vscode-textBlockQuote-background" to panelBg,
            "--vscode-textCodeBlock-background" to editorBg,
            "--vscode-textLink-foreground" to JBUI.CurrentTheme.Link.Foreground.ENABLED,
            "--vscode-textPreformat-foreground" to keyword,
            "--vscode-errorForeground" to error,
            "--vscode-editorWarning-foreground" to warning,
            "--vscode-testing-iconPassed" to success,
            "--vscode-dropdown-background" to inputBg,
            "--vscode-dropdown-foreground" to inputFg,
            "--vscode-dropdown-border" to border,
            "--vscode-gitDecoration-addedResourceForeground" to success,
            "--vscode-gitDecoration-deletedResourceForeground" to error,
            "--vscode-editorWidget-background" to editorBg,
        )
        val vars = LinkedHashMap<String, String>()
        for ((name, color) in colors) vars[name] = cssColor(color)
        vars["--vscode-font-family"] = cssFontFamily(labelFont.family, "system-ui, sans-serif")
        vars["--vscode-font-size"] = "${fontPx}px"
        vars["--vscode-editor-font-family"] = cssFontFamily(scheme.editorFontName, "monospace")
        return vars.filterValues(::isSafeCssValue)
    }

    private fun ui(key: String): Color? = UIManager.getColor(key)

    /** `#rrggbb`, or `rgba(r, g, b, a)` for a translucent colour. */
    fun cssColor(c: Color): String =
        if (c.alpha == 255) {
            "#%02x%02x%02x".format(c.red, c.green, c.blue)
        } else {
            "rgba(${c.red}, ${c.green}, ${c.blue}, ${"%.3f".format(java.util.Locale.ROOT, c.alpha / 255.0)})"
        }

    /** A quoted font family with a generic fallback; characters that could break out of the value are dropped. */
    fun cssFontFamily(family: String?, fallback: String): String {
        val clean = family.orEmpty().filter { it.isLetterOrDigit() || it == ' ' || it == '-' || it == '_' || it == '.' }.trim()
        return if (clean.isEmpty()) fallback else "\"$clean\", $fallback"
    }

    /** A CSS value safe to place inside `<style>:root{…}</style>` (same rule as the JupyterLab host). */
    fun isSafeCssValue(value: String): Boolean = value.length <= 500 && value.none { it in "<>;{}\\" }

    private val VAR_NAME = Regex("^--vscode-[A-Za-z0-9.-]+$")

    /** `<style>:root{--vscode-x:v;…}</style>` with only well-formed names and safe values. */
    fun rootStyle(vars: Map<String, String>): String =
        vars.entries.filter { VAR_NAME.matches(it.key) && isSafeCssValue(it.value) }
            .joinToString(separator = "", prefix = "<style id=\"localpilot-theme\">:root{", postfix = "}</style>") { "${it.key}:${it.value};" }

    /** The `ui/theme { vars }` message for a theme change. */
    fun themeMessage(vars: Map<String, String>): JsonObject = buildJsonObject {
        put("type", "ui/theme")
        putJsonObject("vars") { for ((k, v) in vars) if (VAR_NAME.matches(k) && isSafeCssValue(v)) put(k, v) }
    }
}
