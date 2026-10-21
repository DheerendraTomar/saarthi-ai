package dev.localpilot.rpc

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonRpcTest {
    @Test
    fun encode_is_single_line() {
        val params = buildJsonObject {
            put("text", "line one\nline two\r\n\tend")
        }
        val messages = listOf(
            RpcMessage.Request(JsonPrimitive(1), "chat/send", params),
            RpcMessage.Notification("textDocument/didChange", params),
            RpcMessage.Response(JsonPrimitive(-3), result = params),
            RpcMessage.Response(JsonPrimitive("a"), error = RpcError(-32601, "no\nsuch method", params)),
        )
        for (m in messages) {
            val line = JsonRpc.encode(m)
            assertFalse("embedded newline in $line", line.contains('\n') || line.contains('\r'))
            assertTrue(line.contains("\"jsonrpc\":\"2.0\""))
            assertEquals(m, JsonRpc.decode(line))
        }
        // A response carries exactly one of result/error.
        val ok = JsonRpc.encode(RpcMessage.Response(JsonPrimitive(1), result = JsonNull))
        assertTrue(ok, ok.contains("\"result\":null"))
        assertFalse(ok, ok.contains("\"error\""))
    }

    @Test
    fun decode_request_notification_response() {
        val req = JsonRpc.decode("""{"jsonrpc":"2.0","id":7,"method":"completion/request","params":{"uri":"file:///a.py"}}""")
        assertTrue(req is RpcMessage.Request)
        req as RpcMessage.Request
        assertEquals(JsonPrimitive(7), req.id)
        assertEquals("completion/request", req.method)
        assertEquals("file:///a.py", req.params.jsonObject["uri"]!!.jsonPrimitive.content)

        // Core→client requests use negative ids.
        val back = JsonRpc.decode("""{"jsonrpc":"2.0","id":-2,"method":"workspace/applyEdit","params":{}}""")
        assertEquals(RpcMessage.Request(JsonPrimitive(-2), "workspace/applyEdit", buildJsonObject {}), back)

        val note = JsonRpc.decode("""{"jsonrpc":"2.0","method":"chat/delta","params":{"text":"hi"}}""")
        assertEquals(RpcMessage.Notification("chat/delta", buildJsonObject { put("text", "hi") }), note)

        val res = JsonRpc.decode("""{"jsonrpc":"2.0","id":"s-1","result":{"items":[]}}""")
        assertTrue(res is RpcMessage.Response)
        res as RpcMessage.Response
        assertEquals(JsonPrimitive("s-1"), res.id)
        assertNull(res.error)
        assertTrue(res.result!!.jsonObject.containsKey("items"))

        val err = JsonRpc.decode("""{"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"bad","data":{"x":1}}}""")
        assertEquals(
            RpcMessage.Response(JsonPrimitive(3), error = RpcError(-32602, "bad", buildJsonObject { put("x", 1) })),
            err,
        )
        val errNoData = JsonRpc.decode("""{"jsonrpc":"2.0","id":4,"error":{"code":-32603,"message":"boom"}}""")
        assertEquals(RpcMessage.Response(JsonPrimitive(4), error = RpcError(-32603, "boom")), errNoData)

        // A response with result:null is a success with a JSON-null result.
        val nullResult = JsonRpc.decode("""{"jsonrpc":"2.0","id":5,"result":null}""")
        assertEquals(RpcMessage.Response(JsonPrimitive(5), result = JsonNull), nullResult)
    }

    @Test
    fun decode_tolerates_null_params() {
        assertEquals(
            RpcMessage.Request(JsonPrimitive(1), "shutdown", JsonNull),
            JsonRpc.decode("""{"jsonrpc":"2.0","id":1,"method":"shutdown"}"""),
        )
        assertEquals(
            RpcMessage.Request(JsonPrimitive(2), "shutdown", JsonNull),
            JsonRpc.decode("""{"jsonrpc":"2.0","id":2,"method":"shutdown","params":null}"""),
        )
        assertEquals(
            RpcMessage.Notification("exit", JsonNull),
            JsonRpc.decode("""{"jsonrpc":"2.0","method":"exit","params":null}"""),
        )
        assertEquals(
            RpcMessage.Notification("exit", JsonNull),
            JsonRpc.decode("  {\"jsonrpc\":\"2.0\",\"method\":\"exit\"}\r"),
        )
    }

    @Test
    fun unknown_json_returns_null() {
        val bad = listOf(
            "",
            "   ",
            "not json",
            "{\"jsonrpc\":\"2.0\",",
            "[]",
            "42",
            "null",
            """{"id":1,"method":"x"}""",                       // no jsonrpc
            """{"jsonrpc":"1.0","id":1,"method":"x"}""",       // wrong version
            """{"jsonrpc":2.0,"id":1,"method":"x"}""",         // version not a string
            """{"jsonrpc":"2.0"}""",                           // neither method nor id
            """{"jsonrpc":"2.0","id":1}""",                    // response without result/error
            """{"jsonrpc":"2.0","method":5}""",                // method not a string
            """{"jsonrpc":"2.0","id":{"a":1},"method":"x"}""", // id not number/string
            """{"jsonrpc":"2.0","id":true,"method":"x"}""",    // id boolean
            """{"jsonrpc":"2.0","id":1,"error":{"message":"no code"}}""",
            """{"jsonrpc":"2.0","id":1,"error":"oops"}""",
        )
        for (line in bad) assertNull("expected null for: $line", JsonRpc.decode(line))
    }

    @Test
    fun numeric_ids_are_validated_strictly() {
        for (id in listOf("0", "7", "-1", "-42", "1.5", "1e3", "-2E+2", "3.0e-1")) {
            val msg = JsonRpc.decode("""{"jsonrpc":"2.0","id":$id,"result":{}}""")
            assertTrue("id $id should be accepted", msg is RpcMessage.Response)
            assertEquals(id, (msg as RpcMessage.Response).id.content)
        }
        for (id in listOf("NaN", "Infinity", "-Infinity", "nan", "abc", "01", "-", "1.", ".5", "+1", "0x10", "1e", "true", "false")) {
            assertNull("id $id should be rejected", JsonRpc.decode("""{"jsonrpc":"2.0","id":$id,"result":{}}"""))
            assertNull("request id $id should be rejected", JsonRpc.decode("""{"jsonrpc":"2.0","id":$id,"method":"m"}"""))
        }
    }
}
