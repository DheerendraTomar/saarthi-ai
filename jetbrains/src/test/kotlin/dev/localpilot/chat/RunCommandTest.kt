package dev.localpilot.chat

import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.util.io.FileUtil
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Before
import org.junit.Test
import java.io.File

/** `workspace/runCommand` without the IDE: a real shell in a temp workspace, console output recorded. */
class RunCommandTest {
    private lateinit var workspace: File
    private val console = RecordingConsole()

    class RecordingConsole : ConsoleOutput {
        val text = StringBuilder()
        override fun print(text: String, kind: ConsoleOutput.Kind) {
            synchronized(this.text) { this.text.append(text) }
        }
        fun value() = synchronized(text) { text.toString() }
    }

    @Before
    fun setUp() {
        assumeFalse("POSIX shell tests", SystemInfo.isWindows)
        workspace = FileUtil.createTempDirectory("ws", null)
    }

    @After
    fun tearDown() {
        if (::workspace.isInitialized) FileUtil.delete(workspace)
    }

    private fun run(command: String, cwd: String? = null, timeoutMs: Long = 60_000): JsonObject = runBlocking {
        RunCommand(workspace.toPath(), console, timeoutMs).run(buildJsonObject {
            put("command", command)
            if (cwd != null) put("cwd", cwd)
            put("sessionId", "s1")
        }).jsonObject
    }

    private fun JsonObject.exit() = this["exitCode"]!!.jsonPrimitive.int
    private fun JsonObject.out() = this["stdout"]!!.jsonPrimitive.content
    private fun JsonObject.err() = this["stderr"]!!.jsonPrimitive.content

    @Test
    fun runCommand_captures_tails_and_times_out() {
        // Exit code, both streams, cwd = the workspace by default, echoed to the console.
        val r = run("echo out; echo err 1>&2; pwd; exit 3")
        assertEquals(setOf("exitCode", "stdout", "stderr"), r.keys)
        assertEquals(3, r.exit())
        assertEquals("out\n${workspace.canonicalPath}\n", r.out().replace(workspace.path, workspace.canonicalPath))
        assertEquals("err\n", r.err())
        val echoed = console.value()
        assertTrue(echoed, echoed.contains("$ echo out; echo err 1>&2; pwd; exit 3"))
        assertTrue(echoed, echoed.contains("out\n") && echoed.contains("err\n") && echoed.contains("[exit code 3]"))

        // ~40 KB of stdout: only the last 16 KB come back, marked as truncated; the last line survives.
        val big = run("i=0; while [ \$i -lt 4000 ]; do echo \"line-\$i-xxxxx\"; i=\$((i+1)); done")
        assertEquals(0, big.exit())
        val out = big.out()
        assertTrue(out.startsWith("[… output truncated; last 16 KB shown]\n"))
        val kept = out.removePrefix("[… output truncated; last 16 KB shown]\n")
        assertEquals(RunCommand.OUTPUT_TAIL_CHARS, kept.length)
        assertTrue(kept.endsWith("line-3999-xxxxx\n"))
        assertFalse(kept.contains("line-0-xxxxx\n"))

        // Timeout: the process (and its children) are killed and -1 is reported with a note on stderr.
        val started = System.nanoTime()
        val slow = run("echo before; sleep 30; echo after", timeoutMs = 500)
        val tookMs = (System.nanoTime() - started) / 1_000_000
        assertTrue("took $tookMs ms", tookMs < 10_000)
        assertEquals(-1, slow.exit())
        assertEquals("before\n", slow.out())
        assertTrue(slow.err(), slow.err().contains("timed out after"))
        assertTrue(console.value().contains("timed out after"))
    }

    @Test
    fun runCommand_cwd_confined_to_workspace() {
        File(workspace, "sub").mkdirs()
        val inSub = run("pwd", cwd = File(workspace, "sub").path)
        assertEquals(0, inSub.exit())
        assertTrue(inSub.out(), inSub.out().trim().endsWith("/sub"))
        val relative = run("pwd", cwd = "sub")
        assertEquals(0, relative.exit())
        assertTrue(relative.out(), relative.out().trim().endsWith("/sub"))

        val outside = FileUtil.createTempDirectory("outside", null)
        try {
            val r = run("touch escaped", cwd = outside.path)
            assertEquals(-1, r.exit())
            assertTrue(r.err(), r.err().contains("outside the workspace"))
            assertFalse(File(outside, "escaped").exists())
            val dotdot = run("touch escaped", cwd = "../${outside.name}")
            assertEquals(-1, dotdot.exit())
            assertFalse(File(outside, "escaped").exists())
        } finally {
            FileUtil.delete(outside)
        }
        val missing = run("pwd", cwd = "nope")
        assertEquals(-1, missing.exit())
        assertFalse(missing.err().isBlank())
    }

    @Test
    fun runCommand_bad_params_return_error_result() {
        val r = runBlocking { RunCommand(workspace.toPath(), console).run(buildJsonObject { put("cmd", "ls") }).jsonObject }
        assertEquals(-1, r.exit())
        assertFalse(r.err().isBlank())
        val noWs = runBlocking { RunCommand(null, console).run(buildJsonObject { put("command", "ls") }).jsonObject }
        assertEquals(-1, noWs.exit())
    }
}
