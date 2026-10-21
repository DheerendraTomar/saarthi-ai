package dev.localpilot.completion

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * One shown suggestion, followed through the platform's inline-completion session until it is hidden.
 *
 * The platform keeps a session alive while the user types characters that match the ghost text and while they
 * take it with *Insert Next Word / Line* (it truncates the shown text in place, without a new request), reports
 * each truncation with the event that caused it (typing = `DocumentChange`; anything else that takes text, i.e.
 * Insert Next Word / Line or a matching lookup item, counts as a chunk) and reports the session's end — so unlike
 * VS Code no document diffing, idle timer or typed-prefix hand-off is needed: the outcome is sent when the session
 * ends.
 */
class SuggestionRun(val requestId: String, val suggestion: String) {
    /** The part of [suggestion] still shown as ghost text. */
    var remaining: String = suggestion
        private set

    /** Some of it was taken with a partial accept (Insert Next Word / Line). */
    var chunked: Boolean = false
        private set

    /** The session's elements changed: [remaining] is what is still shown; [partialAccept] if a partial accept caused it. */
    fun update(remaining: String, partialAccept: Boolean) {
        if (partialAccept && remaining.length < this.remaining.length) chunked = true
        this.remaining = remaining
    }

    /** What the user has taken so far: the part of [suggestion] before [remaining]. */
    val taken: String
        get() = if (suggestion.endsWith(remaining)) suggestion.substring(0, suggestion.length - remaining.length) else ""

    /**
     * The `vscode/README.md` "Adaptive completions" rule, applied when the session ends (trailing whitespace is not
     * required):
     * - whole suggestion with a partial accept → `completion/outcome accepted` (`acceptedText` = the suggestion);
     * - whole suggestion typed key by key → `completion/outcome typedThrough`;
     * - part of it with a partial accept → `completion/outcome partial` with `acceptedText`;
     * - otherwise → `completion/rejected`.
     * A full accept (Tab) is reported by the insert handler as `completion/accepted` instead.
     */
    fun outcome(): Pair<String, JsonObject> {
        val taken = taken
        val progressed = taken.isNotEmpty()
        val whole = progressed && taken.trimEnd() == suggestion.trimEnd()
        return when {
            whole && chunked -> COMPLETION_OUTCOME to outcomeParams("accepted", suggestion)
            whole -> COMPLETION_OUTCOME to outcomeParams("typedThrough", null)
            progressed && chunked -> COMPLETION_OUTCOME to outcomeParams("partial", taken)
            else -> COMPLETION_REJECTED to idParams(requestId)
        }
    }

    private fun outcomeParams(outcome: String, acceptedText: String?) = buildJsonObject {
        put("requestId", requestId)
        put("outcome", outcome)
        if (acceptedText != null) put("acceptedText", acceptedText)
    }

    companion object {
        const val COMPLETION_ACCEPTED = "completion/accepted"
        const val COMPLETION_REJECTED = "completion/rejected"
        const val COMPLETION_OUTCOME = "completion/outcome"

        fun idParams(requestId: String) = buildJsonObject { put("requestId", requestId) }
    }
}

/** Sends each request id's outcome at most once (a full accept is seen by both the insert handler and the session end). */
class OutcomeReporter {
    private val reported = LinkedHashSet<String>()

    /** `completion/accepted` for [requestId], unless its outcome was already sent. */
    fun accepted(requestId: String, notify: (String, JsonElement) -> Unit) {
        if (markReported(requestId)) notify(SuggestionRun.COMPLETION_ACCEPTED, SuggestionRun.idParams(requestId))
    }

    /** The outcome of [run] (see [SuggestionRun.outcome]), unless already sent. */
    fun finished(run: SuggestionRun, notify: (String, JsonElement) -> Unit) {
        if (!markReported(run.requestId)) return
        val (method, params) = run.outcome()
        notify(method, params)
    }

    fun wasReported(requestId: String): Boolean = synchronized(reported) { requestId in reported }

    private fun markReported(requestId: String): Boolean = synchronized(reported) {
        if (!reported.add(requestId)) return false
        if (reported.size > MAX_REMEMBERED) reported.remove(reported.first())
        true
    }

    private companion object {
        const val MAX_REMEMBERED = 256
    }
}
