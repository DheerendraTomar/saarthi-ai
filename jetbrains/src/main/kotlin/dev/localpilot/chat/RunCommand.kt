package dev.localpilot.chat

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import dev.localpilot.sync.workspaceOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.InputStream
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * The core's `workspace/runCommand` request (core/src/protocol.rs `RunCommandParams` → `RunCommandResult`
 * `{ exitCode, stdout, stderr }`), the counterpart of the VS Code host's `vscode/src/chat/runCommand.ts`. The core
 * only sends it after the user approved the command.
 *
 * - Runs through the shell as VS Code's `spawn(…, { shell: true })` does: `/bin/sh -c <command>` on macOS/Linux,
 *   `cmd.exe /d /s /c <command>` on Windows, with the IDE's console environment
 *   ([GeneralCommandLine.ParentEnvironmentType.CONSOLE], which on macOS includes the login shell's variables). Stdin
 *   is closed.
 * - cwd: the `cwd` param (absolute, or relative to the workspace) confined to [workspace] (the root itself allowed),
 *   else the workspace.
 * - stdout and stderr are captured separately; each keeps its last [OUTPUT_TAIL_CHARS] characters, marked when cut.
 * - After [timeoutMs] (default [COMMAND_TIMEOUT_MS], 9 min: shorter than the core's 10-minute `CLIENT_REQUEST_TIMEOUT`
 *   so the result still reaches the core) the process tree is killed and `exitCode` is -1 with a note on stderr.
 *   The protocol has no `timedOut` field; this is the VS Code host's convention.
 * - The command, its output and the outcome are echoed to [console].
 * - Never throws (except coroutine cancellation, which kills the process): errors come back as `exitCode: -1` with the
 *   reason on stderr.
 *
 * Implements 5b's `CommandRunner` (`chat/HostHooks.kt`) by signature.
 */
class RunCommand(
    private val workspace: Path?,
    private val console: ConsoleOutput = ConsoleOutput.None,
    private val timeoutMs: Long = COMMAND_TIMEOUT_MS,
) {
    constructor(project: Project) : this(workspaceOf(project), LocalPilotConsole(project))

    /** Keeps the last `limit` characters of a stream. */
    private class Tail(private val limit: Int) {
        private val text = StringBuilder()
        private var dropped = false

        @Synchronized
        fun push(chunk: CharSequence) {
            text.append(chunk)
            if (text.length > 2 * limit) trim()
        }

        private fun trim() {
            if (text.length > limit) {
                text.delete(0, text.length - limit)
                dropped = true
            }
        }

        @Synchronized
        fun value(): String {
            trim()
            return if (dropped) TRUNCATED + text else text.toString()
        }
    }

    suspend fun run(params: JsonElement): JsonElement {
        val obj = params as? JsonObject ?: return result(-1, "", "invalid runCommand request: expected an object")
        val command = (obj["command"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (command.isNullOrBlank()) return result(-1, "", "invalid runCommand request: missing \"command\"")
        val cwdParam = (obj["cwd"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val cwd = try {
            resolveCwd(cwdParam)
        } catch (e: IllegalArgumentException) {
            console.print("$ $command\n[not run: ${e.message}]\n", ConsoleOutput.Kind.SYSTEM)
            return result(-1, "", e.message ?: "invalid cwd")
        }
        console.print("$ $command    (cwd: $cwd)\n", ConsoleOutput.Kind.SYSTEM)
        return try {
            withContext(Dispatchers.IO) { execute(command, cwd) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ProcessCanceledException) {
            throw e
        } catch (e: Throwable) {
            LOG.warn("runCommand failed", e)
            val msg = e.message ?: e.javaClass.simpleName
            console.print("[failed to start: $msg]\n", ConsoleOutput.Kind.SYSTEM)
            result(-1, "", "failed to start in $cwd: $msg")
        }
    }

    private fun resolveCwd(param: String?): Path {
        val root = workspace ?: throw IllegalArgumentException("the project has no folder to run the command in")
        if (param.isNullOrBlank()) return root
        val requested = Path.of(param)
        val path = if (requested.isAbsolute) requested else root.resolve(requested)
        val sameAsRoot = path.toAbsolutePath().normalize() == root.toAbsolutePath().normalize() && requested.none { it.toString() == ".." }
        if (!sameAsRoot && !ApplyEdit.isConfined(root, path)) throw IllegalArgumentException("cwd $param is outside the workspace")
        if (!Files.isDirectory(path)) throw IllegalArgumentException("cwd $param is not a folder")
        return path
    }

    private suspend fun execute(command: String, cwd: Path): JsonElement {
        val commandLine = (if (SystemInfo.isWindows) GeneralCommandLine("cmd.exe", "/d", "/s", "/c", command) else GeneralCommandLine("/bin/sh", "-c", command))
            .withWorkingDirectory(cwd)
            .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
            .withCharset(StandardCharsets.UTF_8)
        val process = commandLine.createProcess()
        try {
            process.outputStream.close()
            val stdout = Tail(OUTPUT_TAIL_CHARS)
            val stderr = Tail(OUTPUT_TAIL_CHARS)
            // Plain daemon threads, not coroutines: a blocking read cannot be cancelled, and a detached grandchild may
            // keep a pipe open after the shell exited — such a reader is abandoned (it ends when the pipe closes).
            val readers = listOf(
                pump(process.inputStream, stdout, ConsoleOutput.Kind.STDOUT),
                pump(process.errorStream, stderr, ConsoleOutput.Kind.STDERR),
            )
            val exit = withTimeoutOrNull(timeoutMs) { runInterruptible { process.waitFor() } }
            if (exit == null) killTree(process)
            runInterruptible {
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
                for (t in readers) t.join(maxOf(1, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())))
            }
            if (exit == null) {
                val note = "timed out after ${formatSeconds(timeoutMs)}; killed"
                val err = stderr.value()
                console.print("[$note]\n", ConsoleOutput.Kind.SYSTEM)
                return result(-1, stdout.value(), err + (if (err.isNotEmpty() && !err.endsWith("\n")) "\n" else "") + note)
            }
            console.print("[exit code $exit]\n", ConsoleOutput.Kind.SYSTEM)
            return result(exit, stdout.value(), stderr.value())
        } finally {
            // Coroutine cancellation (or a failure) must not leave the command running.
            if (process.isAlive) killTree(process)
        }
    }

    private fun pump(stream: InputStream, tail: Tail, kind: ConsoleOutput.Kind): Thread = Thread({
        val reader = InputStreamReader(stream, StandardCharsets.UTF_8)
        val buffer = CharArray(8192)
        try {
            while (true) {
                val n = reader.read(buffer)
                if (n < 0) break
                val chunk = String(buffer, 0, n)
                tail.push(chunk)
                console.print(chunk, kind)
            }
        } catch (_: java.io.IOException) {
            // the pipe broke after a kill
        } finally {
            runCatching { reader.close() }
        }
    }, "LocalPilot runCommand ${kind.name.lowercase()}").apply {
        isDaemon = true
        start()
    }

    private fun killTree(process: Process) {
        val handle = process.toHandle()
        val descendants = runCatching { handle.descendants().toList() }.getOrDefault(emptyList())
        for (child in descendants) child.destroyForcibly()
        handle.destroyForcibly()
        runCatching { process.waitFor(2, TimeUnit.SECONDS) }
    }

    companion object {
        private val LOG = logger<RunCommand>()

        /** Characters of each stream returned to the core (the tail; the start is dropped), as in VS Code. */
        const val OUTPUT_TAIL_CHARS = 16 * 1024

        /** 9 minutes: under the core's 10-minute limit on client requests (`CLIENT_REQUEST_TIMEOUT`, core/src/rpc/server.rs). */
        const val COMMAND_TIMEOUT_MS = 9 * 60 * 1000L

        private fun formatSeconds(ms: Long) = if (ms % 1000 == 0L) "${ms / 1000} s" else "${ms / 1000.0} s"

        private const val TRUNCATED = "[… output truncated; last 16 KB shown]\n"

        private fun result(exitCode: Int, stdout: String, stderr: String): JsonElement = buildJsonObject {
            put("exitCode", exitCode)
            put("stdout", stdout)
            put("stderr", stderr)
        }
    }
}
