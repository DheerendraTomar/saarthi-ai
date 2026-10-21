package dev.localpilot.rpc

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * JSON-RPC 2.0 messages as spoken with the LocalPilot core (newline-delimited, one object per line).
 * Mirrors `core/src/rpc/framing.rs`.
 *
 * Ids are a number or a string, kept as the raw [JsonPrimitive] so they round-trip exactly
 * (the core uses negative numeric ids for core→client requests). A response's id may be
 * [JsonNull] (an error that could not be tied to a request).
 */
sealed class RpcMessage {
    /** A call expecting a [Response]; [params] is [JsonNull] when absent. */
    data class Request(val id: JsonPrimitive, val method: String, val params: JsonElement = JsonNull) : RpcMessage()

    /** A one-way message; [params] is [JsonNull] when absent. */
    data class Notification(val method: String, val params: JsonElement = JsonNull) : RpcMessage()

    /** Success when [error] is null ([result] then defaults to JSON null on the wire), failure otherwise. */
    data class Response(val id: JsonPrimitive, val result: JsonElement? = null, val error: RpcError? = null) : RpcMessage()
}

/** A JSON-RPC error object. Codes: see `core/README.md` (-32600..-32603, -32000 Ollama down, -32001 model missing, -32002 cancelled). */
data class RpcError(val code: Int, val message: String, val data: JsonElement? = null)

object JsonRpc {
    private val json = Json { prettyPrint = false }

    /** A JSON number literal (RFC 8259 §6). */
    private val NUMBER = Regex("""-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?""")

    /** Serializes [msg] to a single line: no trailing newline and no embedded newlines (control chars in strings are escaped). */
    fun encode(msg: RpcMessage): String {
        val obj = buildJsonObject {
            put("jsonrpc", "2.0")
            when (msg) {
                is RpcMessage.Request -> {
                    put("id", msg.id)
                    put("method", msg.method)
                    put("params", msg.params)
                }
                is RpcMessage.Notification -> {
                    put("method", msg.method)
                    put("params", msg.params)
                }
                is RpcMessage.Response -> {
                    put("id", msg.id)
                    val err = msg.error
                    if (err != null) {
                        put("error", buildJsonObject {
                            put("code", err.code)
                            put("message", err.message)
                            err.data?.let { put("data", it) }
                        })
                    } else {
                        put("result", msg.result ?: JsonNull)
                    }
                }
            }
        }
        return json.encodeToString(JsonObject.serializer(), obj)
    }

    /**
     * Parses one line. Returns null for a blank line, invalid JSON, a non-object, a missing or
     * non-"2.0" `jsonrpc`, an id that is not a number/string, or a shape that is neither a
     * request (`method` + `id`), a notification (`method`, no/null `id`) nor a response
     * (`id` + `result`/`error`). Absent or null `params` decode as [JsonNull].
     */
    fun decode(line: String): RpcMessage? {
        if (line.isBlank()) return null
        val obj = try {
            json.parseToJsonElement(line) as? JsonObject
        } catch (_: SerializationException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        } ?: return null

        val version = obj["jsonrpc"] as? JsonPrimitive
        if (version == null || !version.isString || version.content != "2.0") return null

        val id: JsonPrimitive? = when (val raw = obj["id"]) {
            null -> null
            JsonNull -> JsonNull
            // a string, or a JSON number literal; booleans, NaN/Infinity and other unquoted literals are rejected
            is JsonPrimitive -> if (raw.isString || NUMBER.matches(raw.content)) raw else return null
            else -> return null
        }

        val method = obj["method"]
        if (method != null) {
            val name = (method as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
            val params = obj["params"] ?: JsonNull
            return if (id != null && id != JsonNull) RpcMessage.Request(id, name, params)
            else RpcMessage.Notification(name, params)
        }

        if (id == null) return null
        val result = obj["result"]
        val error = when (val raw = obj["error"]) {
            null, JsonNull -> null
            is JsonObject -> parseError(raw) ?: return null
            else -> return null
        }
        if (result == null && error == null) return null
        return RpcMessage.Response(id, result, error)
    }

    private fun parseError(obj: JsonObject): RpcError? {
        val code = (obj["code"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull ?: return null
        if (code < Int.MIN_VALUE || code > Int.MAX_VALUE) return null
        val message = (obj["message"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        val data = obj["data"]?.takeIf { it != JsonNull }
        return RpcError(code.toInt(), message, data)
    }
}
