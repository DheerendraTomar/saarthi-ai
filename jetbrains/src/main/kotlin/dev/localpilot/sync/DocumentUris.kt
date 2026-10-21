package dev.localpilot.sync

import com.intellij.ide.scratch.ScratchUtil
import com.intellij.openapi.application.runReadActionBlocking
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import java.io.IOException
import java.nio.file.Path

/**
 * Documents longer than this many characters are not synced (same cap as the JupyterLab client): an untracked
 * document that shrinks under it is opened, a tracked one that grows past it is closed.
 */
const val MAX_SYNC_CHARS = 1_000_000

/**
 * The URI the core knows [file] by (`file:///…`, percent-encoded by [Path.toUri]). Every sender — document sync,
 * the inline completion provider, chat edits — must use exactly this string for the same file.
 */
fun documentUri(file: VirtualFile): String = nioPath(file).toUri().toString()

private fun nioPath(file: VirtualFile): Path = try {
    file.toNioPath()
} catch (_: UnsupportedOperationException) {
    // Non-NIO file systems (e.g. the in-memory temp FS of light tests): the VFS path is still absolute.
    Path.of(file.path)
}

/**
 * The folder the project's core is initialized with (`workspaceRoot`): `project.basePath`, spelled as the IDE
 * spells it (symlinks unresolved, like the document URIs). Null for a project without one.
 */
fun workspaceOf(project: Project): Path? = project.basePath?.let { Path.of(it) }

/**
 * True if [file] is strictly inside [workspace]. Compared as spelled first (how the core matches URIs against its
 * client-spelled root); if that fails, compared with symlinks resolved on both sides (the core also resolves its
 * root), so a file reached through the real path of a symlinked base path still counts.
 */
fun isUnderWorkspace(file: VirtualFile, workspace: Path): Boolean {
    val path = nioPath(file).toAbsolutePath().normalize()
    val root = workspace.toAbsolutePath().normalize()
    if (path != root && path.startsWith(root)) return true
    return try {
        val realPath = path.toRealPath()
        val realRoot = root.toRealPath()
        realPath != realRoot && realPath.startsWith(realRoot)
    } catch (_: IOException) {
        false
    } catch (_: SecurityException) {
        false
    }
}

/** `.ipynb` files are synced cell by cell (Task 4), never as one plain document. */
fun isNotebookFile(file: VirtualFile): Boolean = file.extension.equals("ipynb", ignoreCase = true)

/**
 * Review Focus 2: true for a real (local, non-scratch, non-in-memory) text file in the project's content that is
 * not part of a library and lies strictly inside [workspace] (the core's `workspaceRoot`; content roots outside
 * it are not synced). Notebooks pass this check too; see [isSyncableFile].
 */
fun isProjectFile(project: Project, file: VirtualFile, workspace: Path? = workspaceOf(project)): Boolean {
    if (project.isDisposed || !file.isValid || file.isDirectory) return false
    if (file is LightVirtualFile || !file.isInLocalFileSystem) return false
    if (file.fileType.isBinary) return false
    if (workspace == null || !isUnderWorkspace(file, workspace)) return false
    return runReadActionBlocking {
        if (ScratchUtil.isScratch(file)) return@runReadActionBlocking false
        val index = ProjectFileIndex.getInstance(project)
        index.isInContent(file) && !index.isInLibrary(file)
    }
}

/** A file synced as one plain document by [DocumentSyncListener] (size permitting): a project file that is not a notebook. */
fun isSyncableFile(project: Project, file: VirtualFile, workspace: Path? = workspaceOf(project)): Boolean =
    !isNotebookFile(file) && isProjectFile(project, file, workspace)

private val LANGUAGE_BY_EXTENSION = mapOf(
    "py" to "python", "pyi" to "python", "pyw" to "python",
    "kt" to "kotlin", "kts" to "kotlin",
    "java" to "java",
    "js" to "javascript", "mjs" to "javascript", "cjs" to "javascript", "jsx" to "javascriptreact",
    "ts" to "typescript", "mts" to "typescript", "cts" to "typescript", "tsx" to "typescriptreact",
    "rs" to "rust", "go" to "go",
    "md" to "markdown", "markdown" to "markdown",
    "json" to "json", "jsonc" to "jsonc",
    "yaml" to "yaml", "yml" to "yaml",
    "sh" to "shellscript", "bash" to "shellscript", "zsh" to "shellscript",
    "txt" to "plaintext", "text" to "plaintext",
    "c" to "c", "h" to "c",
    "cc" to "cpp", "cpp" to "cpp", "cxx" to "cpp", "hpp" to "cpp", "hh" to "cpp", "hxx" to "cpp",
    "cs" to "csharp", "rb" to "ruby", "php" to "php", "swift" to "swift", "scala" to "scala",
    "html" to "html", "htm" to "html", "css" to "css", "scss" to "scss", "less" to "less",
    "sql" to "sql", "toml" to "toml", "xml" to "xml", "lua" to "lua", "r" to "r",
    "ps1" to "powershell", "bat" to "bat", "cmd" to "bat",
    "groovy" to "groovy", "gradle" to "groovy", "dart" to "dart", "vue" to "vue", "svelte" to "svelte",
)

/** IntelliJ file type names (for files without a telling extension) → VS Code language ids. */
private val LANGUAGE_BY_FILE_TYPE = mapOf(
    "Python" to "python", "Kotlin" to "kotlin", "JAVA" to "java", "JavaScript" to "javascript",
    "TypeScript" to "typescript", "Rust" to "rust", "Go" to "go", "Markdown" to "markdown", "JSON" to "json",
    "YAML" to "yaml", "Shell Script" to "shellscript", "PLAIN_TEXT" to "plaintext",
    "Dockerfile" to "dockerfile", "Makefile" to "makefile",
)

/**
 * The VS Code-style language id the core and its stats use for [file]: by extension, then by IntelliJ file type,
 * then the lowercase extension itself, else `plaintext`.
 */
fun languageIdOf(file: VirtualFile): String {
    val ext = file.extension?.lowercase()
    if (ext != null) LANGUAGE_BY_EXTENSION[ext]?.let { return it }
    when (file.name) {
        "Dockerfile" -> return "dockerfile"
        "Makefile", "GNUmakefile" -> return "makefile"
    }
    LANGUAGE_BY_FILE_TYPE[file.fileType.name]?.let { return it }
    return if (ext.isNullOrEmpty()) "plaintext" else ext
}
