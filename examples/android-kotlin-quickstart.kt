import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

fun main() {
    val baseUrl = "https://goodvibes.example.com"
    val token = System.getenv("GOODVIBES_TOKEN") ?: error("GOODVIBES_TOKEN is required")
    val client = OkHttpClient()

    val authRequest = Request.Builder()
        .url("$baseUrl/api/control-plane/auth")
        .header("Authorization", "Bearer $token")
        .build()

    client.newCall(authRequest).execute().use { response ->
        println(response.body?.string())
    }

    val socketRequest = Request.Builder()
        .url("$baseUrl/api/control-plane/ws".replace("https://", "wss://"))
        .build()

    val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
            webSocket.send(
                JSONObject(
                    mapOf(
                        "type" to "auth",
                        "token" to token,
                        "domains" to listOf("agents")
                    )
                ).toString()
            )
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            println(text)
        }
    }

    client.newWebSocket(socketRequest, listener)
}
