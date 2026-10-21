package dev.localpilot.chat

import com.intellij.ide.BrowserUtil
import com.intellij.ide.ui.LafManagerListener
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.asContextElement
import com.intellij.openapi.util.Computable
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.colors.EditorColorsListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.ReadonlyStatusHandler
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import dev.localpilot.rpc.LocalPilotCore
import dev.localpilot.settings.LocalPilotSettings
import dev.localpilot.settings.LocalPilotSettingsState
import dev.localpilot.sync.DocumentSyncService
import dev.localpilot.sync.Position
import dev.localpilot.sync.documentUri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLifeSpanHandlerAdapter
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.awt.BorderLayout
import java.awt.datatransfer.StringSelection
import java.net.URI
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * The "LocalPilot" chat tool window: a JCEF browser hosting the shared chat UI (`/chat/index.html`, copied from
 * `chat-ui/dist/index.html` by `scripts/package-jetbrains.sh`), wired to the project's [ChatService] bridge.
 *
 * UI → host: a `<script>` at the top of `<head>` defines `window.cefQuery({request})` on a [JBCefJSQuery] before the
 * bundle's module script runs (the bundle's `CefBridge` picks it up). Host → UI: `window.postMessage(msg, "*")` via
 * `executeJavaScript`. The page loads nothing from the network (CSP `default-src 'none'`).
 */
class ChatToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = JPanel(BorderLayout())
        val content = ContentFactory.getInstance().createContent(panel, null, false)
        toolWindow.contentManager.addContent(content)
        if (!JBCefApp.isSupported()) {
            panel.add(
                JBLabel("LocalPilot chat needs the embedded browser (JCEF), which this IDE runtime does not support.", SwingConstants.CENTER),
                BorderLayout.CENTER,
            )
            return
        }
        val disposable = Disposer.newDisposable("LocalPilot chat view")
        content.setDisposer(disposable)
        val service = ChatService.getInstance(project)
        val bridge = service.bridge

        val browser = JBCefBrowser.createBuilder().build()
        Disposer.register(disposable, browser)
        // Must exist before the page loads: the page's window.cefQuery shim calls this query's function.
        val query = JBCefJSQuery.create(browser as JBCefBrowserBase)
        Disposer.register(disposable, query)
        query.addHandler { request ->
            bridge.receive(request)
            null
        }
        val sink = UiSink { msg -> browser.cefBrowser.executeJavaScript(ChatHtml.postScript(msg), browser.cefBrowser.url, 0) }
        bridge.ui = sink
        Disposer.register(disposable) { if (bridge.ui === sink) bridge.ui = null }
        installNavigationGuard(browser)
        panel.add(browser.component, BorderLayout.CENTER)

        installListeners(project, bridge, disposable)

        val themeCss = ChatTheme.rootStyle(ChatTheme.currentVars())
        val shim = ChatHtml.cefQueryShim(query)
        // Reading the bundle (a few hundred KB from the plugin jar) stays off the EDT.
        service.scope.launch(Dispatchers.IO) {
            val html = ChatHtml.render(ChatHtml.loadTemplate(), shim, themeCss)
            withContext(Dispatchers.EDT) {
                if (!browser.isDisposed) browser.loadHTML(html, ChatHtml.PAGE_URL)
            }
        }
    }

    /**
     * Keeps the browser on the chat page: chat-ui renders http(s)/mailto links as real anchors, and following one would
     * replace the page (and give the remote page the bridge). Those navigations and every popup are cancelled; a web or
     * mail link the user clicked (a gesture in the main frame) opens in the system browser / mail client instead, and
     * script-driven or sub-frame navigations are cancelled silently. `about:blank` (the browser's initial page) is
     * allowed only until the chat page has loaded, so the context menu's Back cannot blank the pane.
     */
    private fun installNavigationGuard(browser: JBCefBrowser) {
        val pageLoaded = AtomicBoolean(false)
        fun browse(url: String) {
            // CEF callbacks run on the CEF thread; open the link from the EDT.
            ApplicationManager.getApplication().invokeLater { BrowserUtil.browse(url) }
        }
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(cefBrowser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
                if (frame?.isMain != false && ChatHtml.isAllowedNavigation(frame?.url ?: "", ChatHtml.PAGE_URL, pageLoaded = true)) {
                    pageLoaded.set(true)
                }
            }
        }, browser.cefBrowser)
        browser.jbCefClient.addRequestHandler(object : CefRequestHandlerAdapter() {
            override fun onBeforeBrowse(
                cefBrowser: CefBrowser?,
                frame: CefFrame?,
                request: CefRequest?,
                userGesture: Boolean,
                isRedirect: Boolean,
            ): Boolean {
                val url = request?.url ?: return true
                if (ChatHtml.isAllowedNavigation(url, ChatHtml.PAGE_URL, pageLoaded.get())) return false
                if (ChatHtml.opensExternally(url, userGesture, frame?.isMain)) browse(url)
                return true
            }

            // Ctrl/middle-click ("open in a new tab"): never inside the chat browser.
            override fun onOpenURLFromTab(cefBrowser: CefBrowser?, frame: CefFrame?, targetUrl: String?, userGesture: Boolean): Boolean {
                if (targetUrl != null && ChatHtml.opensExternally(targetUrl, userGesture, frame?.isMain)) browse(targetUrl)
                return true
            }
        }, browser.cefBrowser)
        browser.jbCefClient.addLifeSpanHandler(object : CefLifeSpanHandlerAdapter() {
            override fun onBeforePopup(cefBrowser: CefBrowser?, frame: CefFrame?, targetUrl: String?, targetFrameName: String?): Boolean {
                if (targetUrl != null && ChatHtml.opensExternally(targetUrl)) browse(targetUrl)
                return true
            }
        }, browser.cefBrowser)
    }

    private fun installListeners(project: Project, bridge: ChatBridge, disposable: Disposable) {
        val app = ApplicationManager.getApplication()
        val appBus = app.messageBus.connect(disposable)
        val postTheme = { bridge.postRaw(ChatTheme.themeMessage(ChatTheme.currentVars())) }
        appBus.subscribe(LafManagerListener.TOPIC, LafManagerListener { postTheme() })
        appBus.subscribe(EditorColorsManager.TOPIC, EditorColorsListener { postTheme() })
        project.messageBus.connect(disposable).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) = bridge.activeFileChanged()
            },
        )
        val multicaster = EditorFactory.getInstance().eventMulticaster
        multicaster.addSelectionListener(object : SelectionListener {
            override fun selectionChanged(e: SelectionEvent) {
                if (e.editor.project == project) bridge.activeFileChanged()
            }
        }, disposable)
        multicaster.addCaretListener(object : CaretListener {
            override fun caretPositionChanged(event: CaretEvent) {
                if (event.editor.project == project) bridge.activeFileChanged()
            }
        }, disposable)
    }
}

/** The page the tool window loads: shim + theme + the chat-ui bundle (pure string work, unit-tested). */
object ChatHtml {
    const val RESOURCE = "/chat/index.html"

    /**
     * The URL the page is loaded under: `loadHTML(html, PAGE_URL)` serves the in-memory HTML at exactly this
     * `file:///jbcefbrowser/…` URL (JCEF keeps it verbatim; no file is read). It is fixed so the navigation guard can
     * recognise the page; `loadHTML(html)` without a URL would use a generated `file:///jbcefbrowser/<n>` one.
     */
    const val PAGE_URL = "file:///jbcefbrowser/localpilot-chat.html"

    private val EXTERNAL_SCHEMES = setOf("http", "https", "mailto")

    /**
     * Whether the chat browser may navigate to [url]: only its own page [ownUrl] (an in-page `#fragment` included), and
     * `about:blank` only while the page has not loaded yet ([pageLoaded] false; afterwards it would only blank the
     * pane, e.g. via the context menu's Back). Anything else would take the browser off the chat (losing its state) and
     * hand the bridge — every host → UI message and the `cefQuery` function — to that page; the guard cancels it.
     */
    fun isAllowedNavigation(url: String, ownUrl: String, pageLoaded: Boolean): Boolean =
        url == ownUrl || url.startsWith("$ownUrl#") || (url == "about:blank" && !pageLoaded)

    /**
     * Whether a navigation the guard cancelled opens in the system browser / mail client: an http(s)/mailto link the
     * user clicked ([userGesture]) in the main frame ([isMainFrame] null = unknown, treated as main). Script-driven or
     * sub-frame navigations are cancelled silently.
     */
    fun opensExternally(url: String, userGesture: Boolean, isMainFrame: Boolean?): Boolean =
        userGesture && isMainFrame != false && opensExternally(url)

    /** Whether a link the guard cancelled is opened in the system browser / mail client instead (http(s), mailto). */
    fun opensExternally(url: String): Boolean {
        val scheme = try {
            URI(url).scheme
        } catch (_: Exception) {
            null
        } ?: return false
        return scheme.lowercase() in EXTERNAL_SCHEMES
    }

    /** No network, inline scripts/styles only (the bundle is a single file), images from data: URIs. */
    private const val CHARSET = "<meta charset=\"utf-8\">"

    const val CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:"

    private val JSON = Json

    /** The bundled chat-ui page, or null when it was not packaged (a dev build without scripts/package-jetbrains.sh). */
    fun loadTemplate(): String? =
        ChatHtml::class.java.getResourceAsStream(RESOURCE)?.use { it.readBytes().toString(Charsets.UTF_8) }

    /** Shown instead of the chat when the bundle is missing. */
    val MISSING_PAGE = """
        <!doctype html><html><head><meta charset="utf-8"></head>
        <body style="font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 12px">
        <p>The LocalPilot chat UI is not bundled in this build.</p>
        <p>Build the plugin with <code>scripts/package-jetbrains.sh</code> (it copies <code>chat-ui/dist/index.html</code>
        to <code>jetbrains/src/main/resources/chat/index.html</code>).</p>
        </body></html>
    """.trimIndent()

    /**
     * Inserts the CSP `<meta>`, the [shim] script and the theme `<style>` right after the bundle's `<meta charset>`
     * (or, without one, after `<head>` behind a `<meta charset="utf-8">` of our own), so the charset stays within the
     * browser's 1024-byte prescan and `window.cefQuery` exists before the bundle's module script runs;
     * [template] null → [MISSING_PAGE].
     */
    fun render(template: String?, shim: String, themeCss: String): String {
        val page = template ?: MISSING_PAGE
        val inject = "\n<meta http-equiv=\"Content-Security-Policy\" content=\"$CSP\">\n<script>$shim</script>\n$themeCss\n"
        val head = Regex("<head(\\s[^>]*)?>", RegexOption.IGNORE_CASE).find(page)
        if (head != null) {
            val charset = Regex("<meta\\s+charset\\s*=[^>]*>", RegexOption.IGNORE_CASE).find(page, head.range.last + 1)
            val headEnd = page.indexOf("</head", head.range.last + 1, ignoreCase = true)
            if (charset != null && (headEnd < 0 || charset.range.first < headEnd)) {
                val at = charset.range.last + 1
                return page.substring(0, at) + inject + page.substring(at)
            }
            val at = head.range.last + 1
            return page.substring(0, at) + CHARSET + inject + page.substring(at)
        }
        val html = Regex("<html(\\s[^>]*)?>", RegexOption.IGNORE_CASE).find(page)
        if (html != null) {
            val at = html.range.last + 1
            return page.substring(0, at) + "<head>$CHARSET$inject</head>" + page.substring(at)
        }
        return "<head>$CHARSET$inject</head>$page"
    }

    /**
     * `window.cefQuery({ request, onSuccess?, onFailure? })` (the convention of chat-ui's `CefBridge`) on top of
     * [inject], which is `JBCefJSQuery.inject(queryResult, onSuccess, onFailure)`.
     */
    fun cefQueryShim(inject: (String, String, String) -> String): String {
        val call = inject(
            "request",
            "function(response) { if (args && typeof args.onSuccess === 'function') args.onSuccess(response); }",
            "function(code, message) { if (args && typeof args.onFailure === 'function') args.onFailure(code, message); }",
        )
        return "window.cefQuery = function(args) { var request = String(args && args.request); $call return 0; };"
    }

    fun cefQueryShim(query: JBCefJSQuery): String = cefQueryShim { a, b, c -> query.inject(a, b, c) }

    /** JS delivering [message] to the page as a `message` event; the JSON travels as an escaped JS string literal. */
    fun postScript(message: JsonObject): String {
        val literal = JSON.encodeToString(String.serializer(), message.toString())
            .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029").replace("</", "<\\/")
        return "window.postMessage(JSON.parse($literal), '*');"
    }
}

/**
 * One chat bridge per project, alive as long as the project (so the core's `workspace/applyEdit` /
 * `workspace/runCommand` requests are answered even while the tool window is closed, and actions can reach it).
 * Task 5d wires the real edit/command/Ollama implementations with [installHooks] at startup.
 */
@Service(Service.Level.PROJECT)
class ChatService(private val project: Project, cs: CoroutineScope) : Disposable {
    /** Single-threaded FIFO scope: the bridge's state is confined to it. */
    @OptIn(ExperimentalCoroutinesApi::class)
    val scope: CoroutineScope = CoroutineScope(cs.coroutineContext + SupervisorJob(cs.coroutineContext[Job]) + Dispatchers.Default.limitedParallelism(1))

    val bridge: ChatBridge = ChatBridge(
        scope = scope,
        core = CoreProcessChatCore(LocalPilotCore.getInstance(project).process),
        settings = PlatformChatSettings,
        editors = IdeChatEditorHost(project),
    )

    /** Replaces the edit/command/Ollama hooks (Task 5d: ApplyEdit, RunCommand, StartOllama/PullModel actions). */
    fun installHooks(hooks: HostHooks) {
        bridge.hooks = hooks
    }

    override fun dispose() = bridge.dispose()

    companion object {
        fun getInstance(project: Project): ChatService = project.service()
    }
}

private object PlatformChatSettings : ChatSettings {
    override fun read(): LocalPilotSettingsState = LocalPilotSettings.getInstance().state

    override fun write(change: (LocalPilotSettingsState) -> Unit) {
        val settings = LocalPilotSettings.getInstance()
        val next = settings.state
        change(next)
        settings.update(next)
    }
}

/** Editor access for the bridge: reads on the EDT under a read action, inserts in an undoable write command. */
internal class IdeChatEditorHost(
    private val project: Project,
    /** Whether the core syncs the file (default: the project's document sync tracks it). */
    private val isTracked: (VirtualFile) -> Boolean = { DocumentSyncService.getInstance(project).listener?.isTracked(it) == true },
) : ChatEditorHost {
    override suspend fun activeFile(): ActiveFile? = withContext(Dispatchers.EDT) { activeFileNow() }

    /** [activeFile] on the EDT. */
    fun activeFileNow(): ActiveFile? {
        if (project.isDisposed) return null
        return ApplicationManager.getApplication().runReadAction(Computable<ActiveFile?> {
            val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return@Computable null
            val document = editor.document
            val start = editor.selectionModel.selectionStart
            val end = editor.selectionModel.selectionEnd
            val cells = DocumentSyncService.getInstance(project).notebookCells
            if (cells != null && cells.isNotebookDocument(document)) {
                val from = cells.locate(document, start) ?: return@Computable null
                val to = cells.locate(document, end)?.takeIf { it.uri == from.uri }?.position ?: from.position
                return@Computable ActiveFile(from.uri, from.position, to)
            }
            val file = FileDocumentManager.getInstance().getFile(document) ?: return@Computable null
            if (!isTracked(file)) return@Computable null
            fun pos(offset: Int): Position {
                val line = document.getLineNumber(offset)
                return Position(line, offset - document.getLineStartOffset(line))
            }
            ActiveFile(documentUri(file), pos(start), pos(end))
        })
    }

    override fun isAttachable(uri: String): Boolean {
        if (DocumentSyncService.getInstance(project).notebookCells?.cellForUri(uri) != null) return true
        val root = LocalPilotCore.getInstance(project).workspace ?: return false
        return try {
            val parsed = URI(uri)
            parsed.scheme == "file" && Path.of(parsed).toAbsolutePath().normalize().startsWith(root.toAbsolutePath().normalize())
        } catch (_: Exception) {
            false
        }
    }

    override suspend fun insertAtCursor(text: String) {
        // Non-modal: never inserts into an editor behind a dialog that opened meanwhile.
        withContext(Dispatchers.EDT + ModalityState.nonModal().asContextElement()) { insertNow(text) }
    }

    /**
     * [insertAtCursor] on the EDT; false when there is no writable editor (the user is told). A read-only file is first
     * offered to be made writable (VCS checkout / clearing the read-only flag), as for any IDE edit.
     */
    fun insertNow(text: String): Boolean {
        if (project.isDisposed) return false
        val editor = FileEditorManager.getInstance(project).selectedTextEditor
        val file = editor?.let { FileDocumentManager.getInstance().getFile(it.document) }
        if (editor != null && file != null && ReadonlyStatusHandler.getInstance(project).ensureFilesWritable(listOf(file)).hasReadonlyFiles()) {
            notifyNoEditor("${file.name} is read-only; the code was not inserted.")
            return false
        }
        if (editor == null || !editor.document.isWritable) {
            notifyNoEditor("Open an editor to insert the code into.")
            return false
        }
        WriteCommandAction.runWriteCommandAction(project, "Insert from LocalPilot Chat", null, {
            editor.caretModel.runForEachCaret { caret ->
                val from = caret.selectionStart
                editor.document.replaceString(from, caret.selectionEnd, text)
                caret.removeSelection()
                caret.moveToOffset(from + text.length)
            }
        })
        return true
    }

    private fun notifyNoEditor(message: String) {
        NotificationGroupManager.getInstance().getNotificationGroup(LocalPilotCore.NOTIFICATION_GROUP)
            .createNotification("LocalPilot", message, NotificationType.WARNING)
            .notify(project)
    }

    override fun copy(text: String) {
        ApplicationManager.getApplication().invokeLater { CopyPasteManager.getInstance().setContents(StringSelection(text)) }
    }
}
