package com.qwe.codexmobile.data

import android.os.Handler
import android.os.Looper
import com.qwe.codexmobile.model.ApprovalItem
import com.qwe.codexmobile.model.ApprovalQuestion
import com.qwe.codexmobile.model.BootstrapPayload
import com.qwe.codexmobile.model.ChatItem
import com.qwe.codexmobile.model.ConnectionConfig
import com.qwe.codexmobile.model.HostEvent
import com.qwe.codexmobile.model.HostStats
import com.qwe.codexmobile.model.ThreadSummary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

data class FileAttachmentPayload(
    val name: String,
    val mimeType: String,
    val dataUrl: String
)

class HostApiClient {
    private val client = OkHttpClient()
    private val resilientGetClient = client.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .callTimeout(60, TimeUnit.SECONDS)
        .build()
    private val socketClient = client.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var webSocket: WebSocket? = null
    @Volatile
    private var intentionalSocketClose = false

    private fun shouldSuppressSocketCloseMessage(message: String): Boolean {
        val normalized = message.trim()
        return normalized == "界面关闭" ||
            normalized.contains("Software caused connection abort", ignoreCase = true)
    }

    suspend fun testConnection(config: ConnectionConfig) {
        postJson(config, "/api/connect/test", JSONObject())
    }

    suspend fun listThreads(config: ConnectionConfig): List<ThreadSummary> {
        val response = getJson(config, "/api/threads", httpClient = resilientGetClient, retryCount = 1)
        val items = response.getJSONArray("threads")
        return buildList {
            for (index in 0 until items.length()) {
                add(parseThreadSummary(items.getJSONObject(index)))
            }
        }
    }

    suspend fun getThreadItems(config: ConnectionConfig, threadId: String): List<ChatItem> {
        val response = getJson(config, "/api/threads/$threadId", httpClient = resilientGetClient, retryCount = 2)
        val items = response.getJSONObject("thread").getJSONArray("items")
        return buildList {
            for (index in 0 until items.length()) {
                add(parseChatItem(items.getJSONObject(index)))
            }
        }
    }

    suspend fun getStats(config: ConnectionConfig): HostStats {
        val response = getJson(config, "/api/config", httpClient = resilientGetClient, retryCount = 1)
        return parseHostStats(response)
    }

    suspend fun getBootstrap(config: ConnectionConfig): BootstrapPayload {
        val response = getJson(config, "/api/bootstrap", httpClient = resilientGetClient, retryCount = 1)
        val threadItems = response.getJSONArray("threads")
        val approvalItems = response.getJSONArray("approvals")
        return BootstrapPayload(
            stats = parseHostStats(response.getJSONObject("stats")),
            threads = buildList {
                for (index in 0 until threadItems.length()) {
                    add(parseThreadSummary(threadItems.getJSONObject(index)))
                }
            },
            approvals = buildList {
                for (index in 0 until approvalItems.length()) {
                    add(parseApproval(approvalItems.getJSONObject(index)))
                }
            }
        )
    }

    suspend fun setWorkspacePath(config: ConnectionConfig, workspacePath: String) {
        val payload = JSONObject().put("workspacePath", workspacePath.trim())
        postJson(config, "/api/config/workspace", payload)
    }

    suspend fun createThread(config: ConnectionConfig, title: String?): ThreadSummary {
        val payload = JSONObject().apply {
            if (!title.isNullOrBlank()) {
                put("title", title)
            }
        }
        val response = postJson(config, "/api/threads", payload)
        return parseThreadSummary(response.getJSONObject("thread"))
    }

    suspend fun deleteThread(config: ConnectionConfig, threadId: String) {
        deleteJson(config, "/api/threads/$threadId")
    }

    suspend fun sendMessage(
        config: ConnectionConfig,
        threadId: String,
        text: String,
        images: List<String> = emptyList(),
        files: List<FileAttachmentPayload> = emptyList()
    ) {
        val payload = JSONObject().put("text", text)
        if (images.isNotEmpty()) {
            val imageArray = org.json.JSONArray()
            images.forEach { imageArray.put(it) }
            payload.put("images", imageArray)
        }
        if (files.isNotEmpty()) {
            val fileArray = org.json.JSONArray()
            files.forEach { file ->
                fileArray.put(
                    JSONObject()
                        .put("name", file.name)
                        .put("mimeType", file.mimeType)
                        .put("dataUrl", file.dataUrl)
                )
            }
            payload.put("files", fileArray)
        }

        postJson(
            config = config,
            path = "/api/threads/$threadId/message",
            payload = payload
        )
    }

    suspend fun interruptThread(config: ConnectionConfig, threadId: String) {
        postJson(
            config = config,
            path = "/api/threads/$threadId/interrupt",
            payload = JSONObject()
        )
    }

    suspend fun listApprovals(config: ConnectionConfig): List<ApprovalItem> {
        val response = getJson(config, "/api/approvals")
        val items = response.getJSONArray("approvals")
        return buildList {
            for (index in 0 until items.length()) {
                add(parseApproval(items.getJSONObject(index)))
            }
        }
    }

    suspend fun respondApproval(config: ConnectionConfig, requestId: String, approve: Boolean) {
        respondApproval(config, requestId, if (approve) "accept" else "decline")
    }

    suspend fun respondApproval(
        config: ConnectionConfig,
        requestId: String,
        decision: String,
        answers: Map<String, String> = emptyMap()
    ) {
        val payload = JSONObject().put("decision", decision)
        if (answers.isNotEmpty()) {
            val answersJson = JSONObject()
            answers.forEach { (key, value) ->
                answersJson.put(key, value)
            }
            payload.put("answers", answersJson)
        }

        postJson(
            config = config,
            path = "/api/approvals/$requestId/respond",
            payload = payload
        )
    }

    fun connectSocket(
        config: ConnectionConfig,
        onEvent: (HostEvent) -> Unit,
        onOpened: () -> Unit = {},
        onClosed: (String) -> Unit
    ) {
        closeSocket()
        intentionalSocketClose = false
        val encodedToken = URLEncoder.encode(config.token.trim(), Charsets.UTF_8.name())
        val request = Request.Builder()
            .url("${wsBase(config)}/ws?token=$encodedToken")
            .header("Authorization", "Bearer ${config.token.trim()}")
            .build()

        webSocket = socketClient.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    mainHandler.post {
                        onOpened()
                    }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (text == "pong") {
                        return
                    }

                    parseEvent(text)?.let { event ->
                        mainHandler.post {
                            onEvent(event)
                        }
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (intentionalSocketClose) {
                        return
                    }

                    val message = t.message ?: "连接已断开"
                    if (shouldSuppressSocketCloseMessage(message)) {
                        return
                    }

                    mainHandler.post {
                        onClosed(message)
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (intentionalSocketClose) {
                        return
                    }

                    val message = reason.ifBlank { "连接已断开" }
                    if (shouldSuppressSocketCloseMessage(message)) {
                        return
                    }

                    mainHandler.post {
                        onClosed(message)
                    }
                }
            }
        )
    }

    fun closeSocket() {
        intentionalSocketClose = true
        webSocket?.close(1000, "界面关闭")
        webSocket = null
    }

    private suspend fun getJson(config: ConnectionConfig, path: String): JSONObject = withContext(Dispatchers.IO) {
        getJson(config, path, client, 0)
    }

    private suspend fun getJson(
        config: ConnectionConfig,
        path: String,
        httpClient: OkHttpClient,
        retryCount: Int
    ): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${httpBase(config)}$path")
            .header("Authorization", "Bearer ${config.token.trim()}")
            .build()

        executeJsonWithRetry(httpClient, request, retryCount)
    }

    private suspend fun postJson(
        config: ConnectionConfig,
        path: String,
        payload: JSONObject
    ): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${httpBase(config)}$path")
            .header("Authorization", "Bearer ${config.token.trim()}")
            .post(payload.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()

        client.newCall(request).execute().use(::parseJsonResponse)
    }

    private suspend fun deleteJson(config: ConnectionConfig, path: String): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${httpBase(config)}$path")
            .header("Authorization", "Bearer ${config.token.trim()}")
            .delete()
            .build()

        client.newCall(request).execute().use(::parseJsonResponse)
    }

    private fun parseJsonResponse(response: Response): JSONObject {
        val body = response.body?.string().orEmpty()
        if (!response.isSuccessful) {
            val message = runCatching { JSONObject(body).optString("message") }.getOrNull()
            throw IllegalStateException(message?.ifBlank { null } ?: "请求失败：${response.code}")
        }

        return JSONObject(body)
    }

    private suspend fun executeJsonWithRetry(client: OkHttpClient, request: Request, retryCount: Int): JSONObject {
        var attempt = 0
        var lastError: IOException? = null

        while (attempt <= retryCount) {
            try {
                return client.newCall(request).execute().use(::parseJsonResponse)
            } catch (error: IOException) {
                lastError = error
                if (!shouldRetryRequest(error, attempt, retryCount)) {
                    throw error
                }
                delay(350L * (attempt + 1))
            }
            attempt += 1
        }

        throw lastError ?: IOException("请求失败")
    }

    private fun shouldRetryRequest(error: IOException, attempt: Int, retryCount: Int): Boolean {
        if (attempt >= retryCount) {
            return false
        }

        val message = error.message?.lowercase().orEmpty()
        return message.contains("unexpected end of stream") ||
            message.contains("connection reset") ||
            message.contains("stream was reset") ||
            message.contains("timeout") ||
            message.contains("canceled") ||
            message.contains("broken pipe") ||
            message.contains("failed to connect")
    }

    private fun httpBase(config: ConnectionConfig): String {
        val target = parseTarget(config)
        return "${if (target.secure) "https" else "http"}://${target.host}:${target.port}"
    }

    private fun wsBase(config: ConnectionConfig): String {
        val target = parseTarget(config)
        return "${if (target.secure) "wss" else "ws"}://${target.host}:${target.port}"
    }

    private fun parseTarget(config: ConnectionConfig): RequestTarget {
        val rawHost = config.host.trim()
        val port = config.port.trim()
        val secure =
            rawHost.startsWith("https://", ignoreCase = true) ||
                rawHost.startsWith("wss://", ignoreCase = true) ||
                port == "443"

        val host = rawHost
            .removePrefix("http://")
            .removePrefix("https://")
            .removePrefix("ws://")
            .removePrefix("wss://")
            .trimEnd('/')

        return RequestTarget(
            host = host,
            port = port,
            secure = secure
        )
    }

    private data class RequestTarget(
        val host: String,
        val port: String,
        val secure: Boolean
    )

    private fun parseThreadSummary(json: JSONObject): ThreadSummary {
        return ThreadSummary(
            id = json.getString("id"),
            title = json.optString("title", "未命名会话"),
            preview = json.optString("preview"),
            status = json.optString("status", "idle"),
            updatedAt = json.optLong("updatedAt", 0L)
        )
    }

    private fun parseHostStats(json: JSONObject): HostStats {
        return HostStats(
            clientCount = json.optInt("clientCount", 0),
            pendingApprovals = json.optInt("pendingApprovals", 0),
            serviceStatus = json.optString("serviceStatus", "stopped"),
            codexReady = json.optBoolean("codexReady", false),
            lastError = json.optString("errorMessage"),
            workspacePath = json.optString("workspacePath", "")
        )
    }

    private fun parseChatItem(json: JSONObject): ChatItem {
        val rawTimestamp = json.optLong("timestamp", 0L)
        val normalizedTimestamp = when {
            rawTimestamp <= 0L -> 0L
            rawTimestamp < 1_000_000_000_000L -> rawTimestamp * 1000
            else -> rawTimestamp
        }

        return ChatItem(
            id = json.getString("id"),
            turnId = json.optString("turnId"),
            type = json.optString("type"),
            role = json.optString("role").ifBlank { null },
            text = json.optString("text"),
            status = json.optString("status").ifBlank { null },
            timestamp = normalizedTimestamp
        )
    }

    private fun parseApproval(json: JSONObject): ApprovalItem {
        val detailArray = json.optJSONArray("details")
        val questionArray = json.optJSONArray("questions")
        return ApprovalItem(
            requestId = json.getString("requestId"),
            kind = json.optString("kind"),
            summary = json.optString("summary"),
            threadId = json.optString("threadId").ifBlank { null },
            details = buildList {
                if (detailArray != null) {
                    for (index in 0 until detailArray.length()) {
                        val detail = detailArray.optString(index)
                        if (detail.isNotBlank()) {
                            add(detail)
                        }
                    }
                }
            },
            questions = buildList {
                if (questionArray != null) {
                    for (index in 0 until questionArray.length()) {
                        val question = questionArray.optJSONObject(index) ?: continue
                        val optionArray = question.optJSONArray("options")
                        add(
                            ApprovalQuestion(
                                id = question.optString("id", "answer_${index + 1}"),
                                label = question.optString("label", "问题 ${index + 1}"),
                                prompt = question.optString("prompt", question.optString("label", "请输入")),
                                options = buildList {
                                    if (optionArray != null) {
                                        for (optionIndex in 0 until optionArray.length()) {
                                            val option = optionArray.optString(optionIndex)
                                            if (option.isNotBlank()) {
                                                add(option)
                                            }
                                        }
                                    }
                                }
                            )
                        )
                    }
                }
            }
        )
    }

    private fun parseEvent(text: String): HostEvent? {
        val json = JSONObject(text)
        return when (val type = json.optString("type")) {
            "thread.created" -> HostEvent.ThreadCreated(parseThreadSummary(json.getJSONObject("thread")))
            "thread.updated" -> HostEvent.ThreadUpdated(
                threadId = json.getString("threadId"),
                status = json.optString("status", "idle")
            )
            "thread.deleted" -> HostEvent.ThreadDeleted(json.getString("threadId"))

            "turn.started" -> HostEvent.TurnStarted(json.getString("threadId"))
            "turn.completed" -> HostEvent.TurnCompleted(json.getString("threadId"))
            "message.delta" -> HostEvent.MessageDelta(
                threadId = json.getString("threadId"),
                messageId = json.getString("messageId"),
                delta = json.optString("delta"),
                timestamp = normalizeEventTimestamp(json.optLong("timestamp", 0L))
            )

            "message.completed" -> HostEvent.MessageCompleted(
                threadId = json.getString("threadId"),
                messageId = json.getString("messageId"),
                text = json.optString("text"),
                timestamp = normalizeEventTimestamp(json.optLong("timestamp", 0L))
            )

            "approval.required" -> HostEvent.ApprovalRequired(parseApproval(json))
            "approval.resolved" -> HostEvent.ApprovalResolved(json.getString("requestId"))
            "host.state" -> HostEvent.HostState(
                HostStats(
                    clientCount = json.optInt("clientCount", 0),
                    pendingApprovals = json.optInt("pendingApprovals", 0),
                    serviceStatus = json.optString("serviceStatus", "stopped"),
                    codexReady = json.optBoolean("codexReady", false),
                    lastError = json.optString("errorMessage"),
                    workspacePath = json.optString("workspacePath", "")
                )
            )
            "thread.error" -> HostEvent.ThreadError(json.optString("message", "会话出错"))
            "connected" -> null
            else -> {
                if (type.isNotBlank()) {
                    HostEvent.ThreadError("未识别的事件：$type")
                } else {
                    null
                }
            }
        }
    }

    private fun normalizeEventTimestamp(raw: Long): Long {
        return when {
            raw <= 0L -> 0L
            raw < 1_000_000_000_000L -> raw * 1000
            else -> raw
        }
    }
}
