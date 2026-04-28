package com.qwe.codexmobile.ui

import android.app.Activity
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.text.Spannable
import android.text.method.LinkMovementMethod
import android.text.style.URLSpan
import android.util.Base64
import android.widget.TextView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.qwe.codexmobile.data.FileAttachmentPayload
import com.qwe.codexmobile.data.HostApiClient
import com.qwe.codexmobile.data.HostPreferences
import com.qwe.codexmobile.model.ApprovalItem
import com.qwe.codexmobile.model.ApprovalQuestion
import com.qwe.codexmobile.model.ChatItem
import com.qwe.codexmobile.model.ConnectionConfig
import com.qwe.codexmobile.model.HostEvent
import com.qwe.codexmobile.model.HostStats
import com.qwe.codexmobile.model.ThreadSummary
import coil.compose.AsyncImage
import io.noties.markwon.Markwon
import io.noties.markwon.ext.tables.TablePlugin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private enum class Screen {
    Connection,
    Threads,
    Chat
}

private data class PendingImageAttachment(
    val name: String,
    val dataUrl: String
)

private data class PendingFileAttachment(
    val name: String,
    val mimeType: String,
    val dataUrl: String
)

@Composable
fun HostMobileApp() {
    val context = LocalContext.current
    val activity = context as? Activity
    val lifecycleOwner = LocalLifecycleOwner.current
    val preferences = remember { HostPreferences(context) }
    val apiClient = remember { HostApiClient() }
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    var screen by remember { mutableStateOf(Screen.Connection) }
    var config by remember { mutableStateOf(ConnectionConfig()) }
    var isBusy by remember { mutableStateOf(false) }
    var isChatLoading by remember { mutableStateOf(false) }
    var activeThread by remember { mutableStateOf<ThreadSummary?>(null) }
    var hostStats by remember { mutableStateOf(HostStats()) }
    val threads = remember { mutableStateListOf<ThreadSummary>() }
    val chatItems = remember { mutableStateListOf<ChatItem>() }
    val threadItemCache = remember { mutableStateMapOf<String, List<ChatItem>>() }
    val approvals = remember { mutableStateListOf<ApprovalItem>() }
    val latestScreen by rememberUpdatedState(screen)
    val latestConfig by rememberUpdatedState(config)
    var socketReconnectAttempt by remember { mutableStateOf(0) }
    var socketReconnectJob by remember { mutableStateOf<Job?>(null) }
    var socketHasEverOpened by remember { mutableStateOf(false) }
    var chatLoadGeneration by remember { mutableStateOf(0L) }

    fun shouldMaintainSocket(): Boolean {
        return config.isComplete() && screen != Screen.Connection
    }

    fun cancelSocketReconnect() {
        socketReconnectJob?.cancel()
        socketReconnectJob = null
    }

    fun sortThreadsByUpdatedAt() {
        val sortedThreads = threads.sortedByDescending { it.updatedAt }
        threads.clear()
        threads.addAll(sortedThreads)
    }

    fun upsertThreadSummary(thread: ThreadSummary) {
        threads.removeAll { it.id == thread.id }
        threads.add(thread)
        sortThreadsByUpdatedAt()
    }

    fun updateThreadStatus(threadId: String, status: String) {
        val index = threads.indexOfFirst { it.id == threadId }
        if (index >= 0) {
            threads[index] = threads[index].copy(status = status)
            sortThreadsByUpdatedAt()
        }
        if (activeThread?.id == threadId) {
            activeThread = activeThread?.copy(status = status)
        }
    }

    fun updateThreadPreview(threadId: String, preview: String, updatedAt: Long) {
        val index = threads.indexOfFirst { it.id == threadId }
        if (index >= 0) {
            threads[index] = threads[index].copy(preview = preview, updatedAt = updatedAt)
            sortThreadsByUpdatedAt()
        }
        if (activeThread?.id == threadId) {
            activeThread = activeThread?.copy(preview = preview, updatedAt = updatedAt)
        }
    }

    fun replaceVisibleChatItems(threadId: String, items: List<ChatItem>) {
        threadItemCache[threadId] = items
        if (activeThread?.id == threadId) {
            chatItems.clear()
            chatItems.addAll(items)
        }
    }

    suspend fun refreshListsAndStats() {
        val bootstrap = apiClient.getBootstrap(config)
        val latestThreads = bootstrap.threads
        val latestApprovals = bootstrap.approvals
        val latestStats = bootstrap.stats
        val currentThread = activeThread
        val mergedThreads = latestThreads.toMutableList()
        var nextActiveThread = currentThread?.let { current ->
            latestThreads.firstOrNull { it.id == current.id }
        }

        // Freshly created empty threads may not appear in thread/list until the first user message.
        if (screen == Screen.Chat && currentThread != null && nextActiveThread == null && chatItems.isEmpty()) {
            mergedThreads.add(0, currentThread)
            nextActiveThread = currentThread
        }

        val sortedThreads = mergedThreads.sortedByDescending { it.updatedAt }
        threads.clear()
        threads.addAll(sortedThreads)
        approvals.clear()
        approvals.addAll(latestApprovals)
        hostStats = latestStats
        activeThread = nextActiveThread?.let { current ->
            sortedThreads.firstOrNull { it.id == current.id } ?: current
        }
        if (screen == Screen.Chat && activeThread == null) {
            chatItems.clear()
            isChatLoading = false
            screen = Screen.Threads
        }
    }

    suspend fun resolveApproval(
        approval: ApprovalItem,
        decision: String,
        answers: Map<String, String> = emptyMap()
    ) {
        apiClient.respondApproval(config, approval.requestId, decision, answers)
        approvals.removeAll { it.requestId == approval.requestId }
        approval.threadId?.let { threadId ->
            updateThreadStatus(threadId, if (decision == "decline") "idle" else "running")
        }
        refreshListsAndStats()
    }

    suspend fun resyncAfterSocketReconnect(showSuccessMessage: Boolean) {
        refreshListsAndStats()

        val currentThreadId = activeThread?.id
        if (screen == Screen.Chat && currentThreadId != null) {
            val items = apiClient.getThreadItems(config, currentThreadId)
            activeThread = threads.firstOrNull { it.id == currentThreadId } ?: activeThread
            replaceVisibleChatItems(currentThreadId, items)
        }

        if (showSuccessMessage) {
            snackbarHostState.showSnackbar("已重新连接")
        }
    }

    var connectSocketBridge: () -> Unit = {}

    fun scheduleSocketReconnect(reason: String) {
        if (!shouldMaintainSocket()) {
            return
        }

        if (socketReconnectJob?.isActive == true) {
            return
        }

        val attempt = socketReconnectAttempt
        val delayMs = when (attempt) {
            0 -> 1_000L
            1 -> 2_000L
            2 -> 5_000L
            3 -> 10_000L
            else -> 15_000L
        }
        socketReconnectAttempt = attempt + 1

        socketReconnectJob = scope.launch {
            if (attempt == 0 && reason.isNotBlank()) {
                snackbarHostState.showSnackbar(reason)
            }

            delay(delayMs)

            if (!shouldMaintainSocket()) {
                return@launch
            }

            connectSocketBridge()
        }
    }

    connectSocketBridge = {
        apiClient.connectSocket(
            config = config,
            onOpened = {
                val wasReconnect = socketHasEverOpened && socketReconnectAttempt > 0
                cancelSocketReconnect()
                socketReconnectAttempt = 0

                if (wasReconnect) {
                    scope.launch {
                        runCatching {
                            resyncAfterSocketReconnect(showSuccessMessage = true)
                        }.onFailure { error ->
                            snackbarHostState.showSnackbar(error.message ?: "重新连接后同步失败")
                        }
                    }
                }

                socketHasEverOpened = true
            },
            onEvent = { event ->
                when (event) {
                    is HostEvent.ThreadCreated -> {
                        upsertThreadSummary(event.thread)
                    }

                    is HostEvent.ThreadUpdated -> {
                        updateThreadStatus(event.threadId, event.status)
                    }

                    is HostEvent.ThreadDeleted -> {
                        threads.removeAll { it.id == event.threadId }
                        approvals.removeAll { it.threadId == event.threadId }
                        if (activeThread?.id == event.threadId) {
                            activeThread = null
                            chatItems.clear()
                            threadItemCache.remove(event.threadId)
                            isChatLoading = false
                            screen = Screen.Threads
                        }
                        threadItemCache.remove(event.threadId)
                    }

                    is HostEvent.TurnStarted -> {
                        updateThreadStatus(event.threadId, "running")
                    }

                    is HostEvent.TurnCompleted -> {
                        updateThreadStatus(event.threadId, "idle")
                    }

                    is HostEvent.MessageDelta -> {
                        if (activeThread?.id == event.threadId) {
                            val index = chatItems.indexOfFirst { it.id == event.messageId }
                            if (index >= 0) {
                                chatItems[index] = chatItems[index].copy(
                                    text = chatItems[index].text + event.delta,
                                    timestamp = if (event.timestamp > 0L) event.timestamp else chatItems[index].timestamp
                                )
                            } else {
                                chatItems.add(
                                    ChatItem(
                                        id = event.messageId,
                                        turnId = "",
                                        type = "message",
                                        role = "assistant",
                                        text = event.delta,
                                        timestamp = event.timestamp
                                    )
                                )
                            }
                            threadItemCache[event.threadId] = chatItems.toList()
                        }
                    }

                    is HostEvent.MessageCompleted -> {
                        val messageTimestamp = event.timestamp
                        updateThreadPreview(
                            threadId = event.threadId,
                            preview = event.text,
                            updatedAt = if (messageTimestamp > 0L) messageTimestamp else System.currentTimeMillis()
                        )
                        if (activeThread?.id == event.threadId) {
                            val index = chatItems.indexOfFirst { it.id == event.messageId }
                            if (index >= 0) {
                                chatItems[index] = chatItems[index].copy(
                                    text = event.text,
                                    timestamp = if (messageTimestamp > 0L) messageTimestamp else chatItems[index].timestamp
                                )
                            } else {
                                chatItems.add(
                                    ChatItem(
                                        id = event.messageId,
                                        turnId = "",
                                        type = "message",
                                        role = "assistant",
                                        text = event.text,
                                        timestamp = messageTimestamp
                                    )
                                )
                            }
                            threadItemCache[event.threadId] = chatItems.toList()
                        }
                    }

                    is HostEvent.ApprovalRequired -> {
                        approvals.removeAll { it.requestId == event.approval.requestId }
                        approvals.add(event.approval)
                        event.approval.threadId?.let { updateThreadStatus(it, "waiting_approval") }
                    }

                    is HostEvent.ApprovalResolved -> {
                        approvals.removeAll { it.requestId == event.requestId }
                        scope.launch {
                            runCatching { refreshListsAndStats() }
                        }
                    }

                    is HostEvent.HostState -> {
                        hostStats =
                            if (event.stats.workspacePath.isBlank()) {
                                event.stats.copy(workspacePath = hostStats.workspacePath)
                            } else {
                                event.stats
                            }
                    }

                    is HostEvent.ThreadError -> {
                        scope.launch {
                            snackbarHostState.showSnackbar(event.message)
                        }
                    }
                }
            },
            onClosed = { reason ->
                scheduleSocketReconnect(reason)
            }
        )
    }

    suspend fun connectAndLoad(silent: Boolean = false) {
        if (!config.isComplete()) {
            if (!silent) {
                snackbarHostState.showSnackbar("请先填写服务地址、端口、访问令牌和工作目录")
            }
            return
        }

        isBusy = true
        runCatching {
            apiClient.testConnection(config)
            apiClient.setWorkspacePath(config, config.workspacePath)
            refreshListsAndStats()
            preferences.save(config)
            screen = Screen.Threads
            connectSocketBridge()
        }.onFailure { error ->
            if (!silent) {
                snackbarHostState.showSnackbar(error.message ?: "连接失败")
            }
        }
        isBusy = false
    }

    LaunchedEffect(screen, config.host, config.port, config.token) {
        if (!config.isComplete() || screen == Screen.Connection) {
            cancelSocketReconnect()
            apiClient.closeSocket()
            socketReconnectAttempt = 0
            socketHasEverOpened = false
            return@LaunchedEffect
        }

        if (!config.isComplete() || screen != Screen.Threads) {
            return@LaunchedEffect
        }

        while (screen == Screen.Threads) {
            runCatching {
                refreshListsAndStats()
            }
            delay(10_000)
        }
    }

    suspend fun openThread(thread: ThreadSummary) {
        val cachedItems = threadItemCache[thread.id]
        val loadGeneration = chatLoadGeneration + 1
        chatLoadGeneration = loadGeneration
        activeThread = thread
        screen = Screen.Chat
        if (cachedItems != null) {
            chatItems.clear()
            chatItems.addAll(cachedItems)
        } else {
            chatItems.clear()
        }
        isChatLoading = true
        runCatching {
            val items = apiClient.getThreadItems(config, thread.id)
            threadItemCache[thread.id] = items
            if (activeThread?.id == thread.id && chatLoadGeneration == loadGeneration) {
                activeThread = threads.firstOrNull { it.id == thread.id } ?: thread
                chatItems.clear()
                chatItems.addAll(items)
            }
        }.onFailure { error ->
            if (activeThread?.id == thread.id && chatLoadGeneration == loadGeneration) {
                snackbarHostState.showSnackbar(error.message ?: "读取会话失败")
            }
        }
        if (activeThread?.id == thread.id && chatLoadGeneration == loadGeneration) {
            isChatLoading = false
        }
    }

    suspend fun reconnectAndRefresh(
        reopenChat: Boolean,
        showSuccessMessage: Boolean = false
    ) {
        apiClient.testConnection(config)
        refreshListsAndStats()
        connectSocketBridge()

        if (showSuccessMessage) {
            snackbarHostState.showSnackbar("已重新连接")
        }
    }

    fun navigateBackToThreads() {
        screen = Screen.Threads
    }

    BackHandler(enabled = screen != Screen.Connection) {
        when (screen) {
            Screen.Chat -> {
                navigateBackToThreads()
            }

            Screen.Threads -> {
                activity?.moveTaskToBack(true)
            }

            Screen.Connection -> Unit
        }
    }

    LaunchedEffect(Unit) {
        val saved = preferences.load()
        config = saved
        if (saved.isComplete()) {
            connectAndLoad(silent = true)
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            cancelSocketReconnect()
            apiClient.closeSocket()
        }
    }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                val currentConfig = latestConfig
                if (!currentConfig.isComplete() || latestScreen == Screen.Connection) {
                    return@LifecycleEventObserver
                }

                scope.launch {
                    runCatching {
                        reconnectAndRefresh(
                            reopenChat = latestScreen == Screen.Chat,
                            showSuccessMessage = true
                        )
                    }.onFailure { error ->
                        snackbarHostState.showSnackbar(error.message ?: "刷新失败")
                    }
                }
            }
        }

        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0)
    ) { paddingValues ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .padding(paddingValues)
        ) {
            when (screen) {
                Screen.Connection -> ConnectionScreen(
                    config = config,
                    busy = isBusy,
                    onConfigChange = { config = it },
                    onConnect = {
                        scope.launch {
                            connectAndLoad()
                        }
                    }
                )

                Screen.Threads -> ThreadListScreen(
                    threads = threads,
                    approvals = approvals,
                    busy = isBusy,
                    hostStats = hostStats,
                    onBackToSettings = {
                        screen = Screen.Connection
                    },
                    onRefresh = {
                        scope.launch {
                            connectAndLoad()
                        }
                    },
                    onNewThread = {
                        scope.launch {
                            isBusy = true
                            runCatching {
                                val thread = apiClient.createThread(config, null)
                                threads.add(0, thread)
                                activeThread = thread
                                chatItems.clear()
                                threadItemCache[thread.id] = emptyList()
                                isChatLoading = false
                                screen = Screen.Chat
                            }.onFailure { error ->
                                snackbarHostState.showSnackbar(error.message ?: "新建会话失败")
                            }
                            isBusy = false
                        }
                    },
                    onOpenThread = { thread ->
                        scope.launch {
                            openThread(thread)
                        }
                    },
                    onDeleteThread = { thread ->
                        scope.launch {
                            isBusy = true
                            runCatching {
                                apiClient.deleteThread(config, thread.id)
                                threads.removeAll { it.id == thread.id }
                                approvals.removeAll { it.threadId == thread.id }
                                threadItemCache.remove(thread.id)
                                if (activeThread?.id == thread.id) {
                                    activeThread = null
                                    chatItems.clear()
                                    isChatLoading = false
                                    screen = Screen.Threads
                                }
                            }.onFailure { error ->
                                snackbarHostState.showSnackbar(error.message ?: "删除会话失败")
                            }
                            isBusy = false
                        }
                    },
                    onResolveApproval = { approval, decision, answers ->
                        scope.launch {
                            runCatching {
                                resolveApproval(approval, decision, answers)
                            }.onFailure { error ->
                                snackbarHostState.showSnackbar(error.message ?: "审批提交失败")
                            }
                        }
                    }
                )

                Screen.Chat -> ChatScreen(
                    thread = activeThread,
                    approvals = approvals.filter { it.threadId == null || it.threadId == activeThread?.id },
                    items = chatItems,
                    busy = isBusy,
                    loadingContent = isChatLoading,
                    onBack = ::navigateBackToThreads,
                    onRefresh = {
                        scope.launch {
                            val thread = activeThread ?: return@launch
                            runCatching {
                                openThread(thread)
                            }.onFailure { error ->
                                snackbarHostState.showSnackbar(error.message ?: "刷新失败")
                            }
                        }
                    },
                    onSend = { text, images, files ->
                        scope.launch {
                            val thread = activeThread ?: return@launch
                            val summaryText = buildString {
                                if (text.isNotBlank()) {
                                    append(text)
                                }
                                if (images.isNotEmpty()) {
                                    if (isNotEmpty()) {
                                        append("\n")
                                    }
                                    append("[图片 ${images.size} 张]")
                                }
                                if (files.isNotEmpty()) {
                                    if (isNotEmpty()) {
                                        append("\n")
                                    }
                                    append("[文件 ${files.size} 个]")
                                }
                            }
                            chatItems.add(
                                ChatItem(
                                    id = "local-${System.currentTimeMillis()}",
                                    turnId = "",
                                    type = "message",
                                    role = "user",
                                    text = summaryText,
                                    timestamp = System.currentTimeMillis()
                                )
                            )
                            threadItemCache[thread.id] = chatItems.toList()
                            updateThreadStatus(thread.id, "running")
                            runCatching {
                                apiClient.sendMessage(
                                    config = config,
                                    threadId = thread.id,
                                    text = text,
                                    images = images.map { it.dataUrl },
                                    files = files.map { file ->
                                        FileAttachmentPayload(
                                            name = file.name,
                                            mimeType = file.mimeType,
                                            dataUrl = file.dataUrl
                                        )
                                    }
                                )
                            }.onFailure { error ->
                                snackbarHostState.showSnackbar(error.message ?: "发送失败")
                            }
                        }
                    },
                    onInterrupt = {
                        scope.launch {
                            val thread = activeThread ?: return@launch
                            runCatching {
                                apiClient.interruptThread(config, thread.id)
                            }.onFailure { error ->
                                snackbarHostState.showSnackbar(error.message ?: "停止失败")
                            }
                        }
                    },
                    onResolveApproval = { approval, decision, answers ->
                        scope.launch {
                            runCatching {
                                resolveApproval(approval, decision, answers)
                            }.onFailure { error ->
                                snackbarHostState.showSnackbar(error.message ?: "审批提交失败")
                            }
                        }
                    }
                )
            }

            if (isBusy) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(16.dp)
                )
            }

            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .padding(start = 16.dp, end = 16.dp, top = 12.dp),
                snackbar = { snackbarData ->
                    Snackbar(
                        snackbarData = snackbarData,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            )
        }
    }
}

@Composable
private fun ConnectionScreen(
    config: ConnectionConfig,
    busy: Boolean,
    onConfigChange: (ConnectionConfig) -> Unit,
    onConnect: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text("连接到 CodeX 主机", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)

        OutlinedTextField(
            value = config.host,
            onValueChange = { onConfigChange(config.copy(host = it)) },
            label = { Text("服务地址") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true
        )

        OutlinedTextField(
            value = config.port,
            onValueChange = { onConfigChange(config.copy(port = it.filter(Char::isDigit))) },
            label = { Text("端口") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
        )

        OutlinedTextField(
            value = config.token,
            onValueChange = { onConfigChange(config.copy(token = it)) },
            label = { Text("访问令牌") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true
        )

        OutlinedTextField(
            value = config.workspacePath,
            onValueChange = { onConfigChange(config.copy(workspacePath = it)) },
            label = { Text("工作目录") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true
        )

        Button(
            onClick = onConnect,
            enabled = !busy && config.isComplete(),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("保存并连接")
        }

        Spacer(modifier = Modifier.weight(1f))

        Text("第一次只需要填一次地址、端口和访问令牌。之后会自动保存在本地。", style = MaterialTheme.typography.bodyMedium)
        Text(
            "当前继续使用 HTTP 连接。请确保端口映射、动态域名和访问令牌都已正确配置。",
            style = MaterialTheme.typography.bodySmall
        )
        Text("by.冰点零度", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun ThreadListScreen(
    threads: List<ThreadSummary>,
    approvals: List<ApprovalItem>,
    busy: Boolean,
    hostStats: HostStats,
    onBackToSettings: () -> Unit,
    onRefresh: () -> Unit,
    onNewThread: () -> Unit,
    onOpenThread: (ThreadSummary) -> Unit,
    onDeleteThread: (ThreadSummary) -> Unit,
    onResolveApproval: (ApprovalItem, String, Map<String, String>) -> Unit
) {
    val threadTitleMap = remember(threads) {
        threads.associate { it.id to it.title }
    }
    var menuThreadId by remember { mutableStateOf<String?>(null) }
    val workspacePathText = hostStats.workspacePath.ifBlank { "--" }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 16.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                "设备 ${hostStats.clientCount} 台，待审批 ${hostStats.pendingApprovals} 个 · 主机${statusLabel(hostStats.serviceStatus)} · CodeX${if (hostStats.codexReady) "已连接" else "未连接"}",
                style = MaterialTheme.typography.bodySmall
            )
            Text(
                "当前工作目录：$workspacePathText",
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onBackToSettings) { Text("连接设置") }
                TextButton(onClick = onRefresh, enabled = !busy) { Text("刷新") }
            }

            if (approvals.isNotEmpty()) {
                Text("待处理审批", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                approvals.forEach { approval ->
                    ApprovalCard(
                        approval = approval,
                        threadTitle = approval.threadId?.let(threadTitleMap::get),
                        onResolve = onResolveApproval
                    )
                }
            }

            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.weight(1f, fill = false)
            ) {
                items(threads, key = { it.id }) { thread ->
                    Box {
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .combinedClickable(
                                    onClick = { onOpenThread(thread) },
                                    onLongClick = { menuThreadId = thread.id }
                                )
                        ) {
                            Column(modifier = Modifier.padding(16.dp)) {
                                Text(
                                    thread.title,
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis
                                )
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    compactThreadPreview(thread.preview).ifBlank { "暂无摘要" },
                                    style = MaterialTheme.typography.bodySmall
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                Text(
                                    buildAnnotatedString {
                                        withStyle(SpanStyle(color = Color(0xFF9A9A9A))) {
                                            append("状态：")
                                        }
                                        withStyle(SpanStyle(color = threadStatusValueColor(thread.status))) {
                                            append(statusLabel(thread.status))
                                        }
                                        withStyle(SpanStyle(color = Color(0xFF9A9A9A))) {
                                            append(" · ")
                                            append(formatThreadTimestamp(toEpochMillis(thread.updatedAt)))
                                        }
                                    },
                                    style = MaterialTheme.typography.labelSmall
                                )
                            }
                        }

                        DropdownMenu(
                            expanded = menuThreadId == thread.id,
                            onDismissRequest = { menuThreadId = null }
                        ) {
                            DropdownMenuItem(
                                text = { Text("进入") },
                                onClick = {
                                    menuThreadId = null
                                    onOpenThread(thread)
                                }
                            )
                            DropdownMenuItem(
                                text = { Text("新建") },
                                onClick = {
                                    menuThreadId = null
                                    onNewThread()
                                }
                            )
                            DropdownMenuItem(
                                text = { Text("删除") },
                                onClick = {
                                    menuThreadId = null
                                    onDeleteThread(thread)
                                }
                            )
                        }
                    }
                }
            }
        }

        FloatingActionButton(
            onClick = onNewThread,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .navigationBarsPadding()
                .offset(y = (-8).dp)
        ) {
            Text("新建")
        }
    }
}

@Composable
private fun ChatScreen(
    thread: ThreadSummary?,
    approvals: List<ApprovalItem>,
    items: List<ChatItem>,
    busy: Boolean,
    loadingContent: Boolean,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onSend: (String, List<PendingImageAttachment>, List<PendingFileAttachment>) -> Unit,
    onInterrupt: () -> Unit,
    onResolveApproval: (ApprovalItem, String, Map<String, String>) -> Unit
) {
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var input by remember { mutableStateOf("") }
    var isInputFocused by remember { mutableStateOf(false) }
    var hasInitializedBottomScroll by remember(thread?.id) { mutableStateOf(false) }
    var listVisible by remember(thread?.id) { mutableStateOf(false) }
    val pendingImages = remember { mutableStateListOf<PendingImageAttachment>() }
    val pendingFiles = remember { mutableStateListOf<PendingFileAttachment>() }
    val displayItems = remember(items) { items.asReversed() }
    val imagePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetMultipleContents()
    ) { uris ->
        if (uris.isNullOrEmpty()) {
            return@rememberLauncherForActivityResult
        }

        scope.launch {
            val attachments = uris.mapNotNull { uri ->
                runCatching { readImageAttachment(context, uri) }.getOrNull()
            }
            pendingImages.clear()
            pendingImages.addAll(attachments.take(3))
        }
    }
    val filePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        if (uris.isNullOrEmpty()) {
            return@rememberLauncherForActivityResult
        }

        scope.launch {
            val attachments = uris.mapNotNull { uri ->
                runCatching { readFileAttachment(context, uri) }.getOrNull()
            }
            pendingFiles.clear()
            pendingFiles.addAll(attachments.take(5))
        }
    }

    val dismissKeyboard: () -> Unit = {
        focusManager.clearFocus(force = true)
        keyboardController?.hide()
    }

    BackHandler(enabled = isInputFocused) {
        dismissKeyboard()
    }

    LaunchedEffect(thread?.id, displayItems.size) {
        if (displayItems.isEmpty()) {
            listVisible = true
            return@LaunchedEffect
        }

        val nearBottom = listState.firstVisibleItemIndex <= 1
        if (!hasInitializedBottomScroll) {
            listState.scrollToItem(0)
            hasInitializedBottomScroll = true
            listVisible = true
            return@LaunchedEffect
        }

        if (nearBottom) {
            listState.animateScrollToItem(0)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .offset(y = (-2).dp)
            .padding(start = 16.dp, end = 16.dp, top = 0.dp, bottom = 0.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp)
    ) {
        Text(
            thread?.title ?: "会话",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )

        Row(
            modifier = Modifier
                .fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(color = Color(0xFF89BFE3))) {
                        append("状态：")
                    }
                    withStyle(SpanStyle(color = Color(0xFF8A63D2))) {
                        append(statusLabel(thread?.status ?: "idle"))
                    }
                },
                style = MaterialTheme.typography.bodySmall
            )
            TopActionLabel(
                text = "+",
                enabled = !busy,
                onClick = { filePickerLauncher.launch(arrayOf("*/*")) }
            )
            Spacer(modifier = Modifier.weight(1f))
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                TopActionLabel(text = "刷新", enabled = !busy && !loadingContent, onClick = onRefresh)
                TopActionLabel(text = "返回", onClick = onBack)
                TopActionLabel(text = "停止", enabled = !busy, onClick = onInterrupt)
            }
        }

        if (approvals.isNotEmpty()) {
            approvals.forEach { approval ->
                ApprovalCard(
                    approval = approval,
                    threadTitle = thread?.title,
                    onResolve = onResolveApproval
                )
            }
        }

        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .offset(y = 0.dp)
        ) {
            LazyColumn(
                state = listState,
                reverseLayout = true,
                modifier = Modifier
                    .fillMaxSize()
                    .alpha(if (listVisible) 1f else 0f)
                    .pointerInput(Unit) {
                        detectTapGestures(
                            onTap = {
                                dismissKeyboard()
                            }
                        )
                    }
                    .padding(horizontal = 3.dp, vertical = 0.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp)
            ) {
                items(displayItems, key = { it.id }) { item ->
                    MessageBubble(
                        item = item,
                        onTap = dismissKeyboard
                    )
                }
            }

            if (loadingContent && items.isEmpty()) {
                Column(
                    modifier = Modifier.align(Alignment.Center),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    CircularProgressIndicator()
                    Text("正在加载会话内容…", style = MaterialTheme.typography.bodyMedium)
                }
            } else if (loadingContent) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(8.dp)
                        .width(18.dp)
                        .height(18.dp),
                    strokeWidth = 2.dp
                )
            }
        }

        Column(
            modifier = Modifier
                .navigationBarsPadding()
                .offset(y = (-1).dp),
            verticalArrangement = Arrangement.spacedBy(1.dp)
        ) {
            if (pendingImages.isNotEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        "已选图片 ${pendingImages.size} 张：${pendingImages.joinToString("、") { it.name }}",
                        style = MaterialTheme.typography.labelSmall
                    )
                    TextButton(onClick = { pendingImages.clear() }) {
                        Text("清空")
                    }
                }
            }
            if (pendingFiles.isNotEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        "已选文件 ${pendingFiles.size} 个：${pendingFiles.joinToString("、") { it.name }}",
                        style = MaterialTheme.typography.labelSmall
                    )
                    TextButton(onClick = { pendingFiles.clear() }) {
                        Text("清空")
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.Bottom
            ) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    label = { Text("输入要发送给 CodeX 的内容") },
                    modifier = Modifier
                        .weight(1f)
                        .onFocusChanged { isInputFocused = it.isFocused },
                    minLines = 2,
                    maxLines = 4,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp)
                )

                Column(
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                    horizontalAlignment = Alignment.End
                ) {
                    TextButton(
                        onClick = { imagePickerLauncher.launch("image/*") },
                        enabled = !busy && !loadingContent
                    ) {
                        Text("图片")
                    }

                    Button(
                        onClick = {
                            val trimmed = input.trim()
                            if (trimmed.isNotBlank() || pendingImages.isNotEmpty() || pendingFiles.isNotEmpty()) {
                                onSend(trimmed, pendingImages.toList(), pendingFiles.toList())
                                input = ""
                                pendingImages.clear()
                                pendingFiles.clear()
                            }
                        },
                        enabled = !busy && !loadingContent && (input.isNotBlank() || pendingImages.isNotEmpty() || pendingFiles.isNotEmpty())
                    ) {
                        Text("发送")
                    }
                }
            }
        }
    }
}

@Composable
private fun ApprovalCard(
    approval: ApprovalItem,
    threadTitle: String? = null,
    onResolve: (ApprovalItem, String, Map<String, String>) -> Unit
) {
    val answers = remember(approval.requestId) { mutableStateMapOf<String, String>() }
    val isInputApproval = approval.kind == "user_input" && approval.questions.isNotEmpty()
    val allQuestionsAnswered = approval.questions.all { question ->
        answers[question.id].orEmpty().isNotBlank()
    }

    Card {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("审批类型：${approvalKindLabel(approval.kind)}", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            if (!threadTitle.isNullOrBlank()) {
                Text("相关会话：$threadTitle", style = MaterialTheme.typography.bodySmall)
            }
            Text(approval.summary.ifBlank { "等待审批" }, style = MaterialTheme.typography.bodySmall)

            approval.details.forEach { detail ->
                Text("• $detail", style = MaterialTheme.typography.bodySmall)
            }

            if (isInputApproval) {
                approval.questions.forEach { question ->
                    ApprovalQuestionField(
                        question = question,
                        value = answers[question.id].orEmpty(),
                        onValueChange = { answers[question.id] = it }
                    )
                }

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = {
                            onResolve(
                                approval,
                                "accept",
                                approval.questions.associate { it.id to answers[it.id].orEmpty() }
                            )
                        },
                        enabled = allQuestionsAnswered
                    ) {
                        Text("提交输入")
                    }
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onResolve(approval, "accept", emptyMap()) }) {
                        Text("批准")
                    }
                    TextButton(onClick = { onResolve(approval, "decline", emptyMap()) }) {
                        Text("拒绝")
                    }
                }
            }
        }
    }
}

@Composable
private fun ApprovalQuestionField(
    question: ApprovalQuestion,
    value: String,
    onValueChange: (String) -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(question.label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium)
        Text(question.prompt, style = MaterialTheme.typography.bodySmall)
        if (question.options.isNotEmpty()) {
            Text(
                "可选：${question.options.joinToString(" / ")}",
                style = MaterialTheme.typography.labelSmall
            )
        }
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth(),
            singleLine = false,
            maxLines = 3,
            label = { Text("输入内容") }
        )
    }
}

@Composable
private fun MessageBubble(item: ChatItem, onTap: () -> Unit) {
    val clipboardManager = LocalClipboardManager.current
    val context = LocalContext.current
    val isUser = item.role == "user"
    val isAssistant = item.role == "assistant"
    val background = if (isUser) MaterialTheme.colorScheme.primary else Color(0xFFFEFCF7)
    val foreground = if (isUser) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
    val markwon = remember(context) {
        Markwon.builder(context)
            .usePlugin(TablePlugin.create(context))
            .build()
    }
    var actionMenuVisible by remember(item.id) { mutableStateOf(false) }
    var selectionDialogVisible by remember(item.id) { mutableStateOf(false) }
    val bodyText = item.text.ifBlank { item.status.orEmpty() }

    Box(
        modifier = Modifier
            .fillMaxWidth()
    ) {
        Column(
            modifier = Modifier
                .then(
                    if (isAssistant) {
                        Modifier
                            .fillMaxWidth()
                            .expandBubbleWidth(startExtra = 4.dp, endExtra = 1.dp)
                    } else {
                        Modifier
                    }
                )
                .align(if (isUser) Alignment.CenterEnd else Alignment.CenterStart)
                .combinedClickable(
                    onClick = onTap,
                    onLongClick = {
                        actionMenuVisible = true
                    }
                )
                .background(background, RoundedCornerShape(14.dp))
                .padding(horizontal = 10.dp, vertical = 6.dp)
        ) {
            if (bodyText.isNotBlank()) {
                Box {
                    if (isAssistant) {
                        AndroidView(
                            factory = { viewContext ->
                                TextView(viewContext).apply {
                                    textSize = 14f
                                    autoLinkMask = 0
                                    linksClickable = false
                                    isClickable = true
                                    isLongClickable = true
                                    setTextIsSelectable(false)
                                    movementMethod = null
                                }
                            },
                            update = { textView ->
                                textView.textSize = 14f
                                textView.setTextColor(foreground.toArgb())
                                textView.autoLinkMask = 0
                                textView.linksClickable = false
                                textView.movementMethod = null
                                textView.setOnClickListener {
                                    onTap()
                                }
                                textView.setOnLongClickListener {
                                    actionMenuVisible = true
                                    true
                                }
                                markwon.setMarkdown(textView, bodyText)
                                val hasHttpLinks = keepOnlyHttpLinks(textView)
                                textView.linksClickable = hasHttpLinks
                                textView.movementMethod = if (hasHttpLinks) {
                                    LinkMovementMethod.getInstance()
                                } else {
                                    null
                                }
                            },
                            modifier = Modifier.fillMaxWidth()
                        )
                    } else {
                        Text(
                            bodyText,
                            color = foreground,
                            style = MaterialTheme.typography.bodySmall.copy(fontSize = 14.sp)
                        )
                    }
                }
            }

            if (item.images.isNotEmpty()) {
                if (bodyText.isNotBlank()) {
                    Spacer(modifier = Modifier.height(8.dp))
                }

                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    item.images.forEach { image ->
                        AsyncImage(
                            model = image.url,
                            contentDescription = "聊天图片",
                            contentScale = ContentScale.Fit,
                            modifier = Modifier
                                .widthIn(max = 240.dp)
                                .heightIn(max = 260.dp)
                                .clip(RoundedCornerShape(10.dp))
                                .background(Color.White.copy(alpha = if (isUser) 0.18f else 0.45f))
                        )
                    }
                }
            }
        }

        DropdownMenu(
            expanded = actionMenuVisible,
            onDismissRequest = { actionMenuVisible = false }
        ) {
            DropdownMenuItem(
                text = { Text("复制") },
                onClick = {
                    if (item.text.isNotBlank()) {
                        clipboardManager.setText(AnnotatedString(item.text))
                    }
                    actionMenuVisible = false
                }
            )
            DropdownMenuItem(
                text = { Text("选取文字") },
                onClick = {
                    actionMenuVisible = false
                    selectionDialogVisible = true
                }
            )
        }
    }

    if (selectionDialogVisible) {
        AlertDialog(
            onDismissRequest = { selectionDialogVisible = false },
            title = { Text("选取文字") },
            text = {
                androidx.compose.foundation.text.selection.SelectionContainer {
                    Text(item.text.ifBlank { item.status.orEmpty() }, style = MaterialTheme.typography.bodyMedium)
                }
            },
            confirmButton = {
                TextButton(onClick = { selectionDialogVisible = false }) {
                    Text("完成")
                }
            },
            dismissButton = {
                TextButton(onClick = {
                    if (item.text.isNotBlank()) {
                        clipboardManager.setText(AnnotatedString(item.text))
                    }
                    selectionDialogVisible = false
                }) {
                    Text("复制")
                }
            }
        )
    }
}

private fun Modifier.expandBubbleWidth(startExtra: Dp, endExtra: Dp): Modifier = layout { measurable, constraints ->
    val startPx = startExtra.roundToPx()
    val endPx = endExtra.roundToPx()
    val expandedConstraints = Constraints(
        minWidth = constraints.minWidth + startPx + endPx,
        maxWidth = constraints.maxWidth + startPx + endPx,
        minHeight = constraints.minHeight,
        maxHeight = constraints.maxHeight
    )
    val placeable = measurable.measure(expandedConstraints)

    layout(constraints.maxWidth, placeable.height) {
        placeable.placeRelative(-startPx, 0)
    }
}

private fun keepOnlyHttpLinks(textView: TextView): Boolean {
    val spannable = textView.text as? Spannable ?: return false
    var hasHttpLinks = false
    val spans = spannable.getSpans(0, spannable.length, URLSpan::class.java)
    spans.forEach { span ->
        val url = span.url.orEmpty()
        val allow = url.startsWith("http://", ignoreCase = true) ||
            url.startsWith("https://", ignoreCase = true)
        if (allow) {
            hasHttpLinks = true
        } else {
            spannable.removeSpan(span)
        }
    }
    return hasHttpLinks
}

private fun approvalKindLabel(kind: String): String {
    return when (kind) {
        "command" -> "命令执行"
        "file_change" -> "文件修改"
        "user_input" -> "等待输入"
        else -> "审批"
    }
}

private fun compactThreadPreview(value: String): String {
    val normalized = value.replace("\\s+".toRegex(), " ").trim()
    if (normalized.length <= 52) {
        return normalized
    }
    return normalized.take(52).trimEnd() + "…"
}

private fun formatThreadTimestamp(timestamp: Long): String {
    if (timestamp <= 0L) {
        return "--"
    }
    return SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(timestamp))
}

private fun toEpochMillis(raw: Long): Long {
    return when {
        raw <= 0L -> 0L
        raw < 1_000_000_000_000L -> raw * 1000
        else -> raw
    }
}

private suspend fun readImageAttachment(
    context: android.content.Context,
    uri: Uri
): PendingImageAttachment? = withContext(Dispatchers.IO) {
    val inputStream = context.contentResolver.openInputStream(uri) ?: return@withContext null
    val bitmap = inputStream.use(BitmapFactory::decodeStream) ?: return@withContext null

    val maxDimension = 1440f
    val scale = minOf(1f, maxDimension / maxOf(bitmap.width, bitmap.height).toFloat())
    val scaledBitmap = if (scale < 1f) {
        android.graphics.Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * scale).toInt().coerceAtLeast(1),
            (bitmap.height * scale).toInt().coerceAtLeast(1),
            true
        )
    } else {
        bitmap
    }

    val buffer = ByteArrayOutputStream()
    scaledBitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 82, buffer)
    if (scaledBitmap !== bitmap) {
        scaledBitmap.recycle()
    }
    bitmap.recycle()

    val base64 = Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP)
    val name = queryDisplayName(context, uri) ?: "图片_${System.currentTimeMillis()}.jpg"

    PendingImageAttachment(
        name = name,
        dataUrl = "data:image/jpeg;base64,$base64"
    )
}

private suspend fun readFileAttachment(
    context: android.content.Context,
    uri: Uri
): PendingFileAttachment? = withContext(Dispatchers.IO) {
    val inputStream = context.contentResolver.openInputStream(uri) ?: return@withContext null
    val bytes = inputStream.use { it.readBytes() }
    if (bytes.isEmpty()) {
        return@withContext null
    }

    val mimeType = context.contentResolver.getType(uri).orEmpty().ifBlank { "application/octet-stream" }
    val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
    val name = queryDisplayName(context, uri) ?: "附件_${System.currentTimeMillis()}"

    PendingFileAttachment(
        name = name,
        mimeType = mimeType,
        dataUrl = "data:$mimeType;base64,$base64"
    )
}

private fun queryDisplayName(
    context: android.content.Context,
    uri: Uri
): String? {
    return context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (index >= 0 && cursor.moveToFirst()) {
            cursor.getString(index)
        } else {
            null
        }
    }
}

private fun statusLabel(status: String): String {
    return when (status) {
        "idle" -> "空闲"
        "running" -> "运行中"
        "starting" -> "启动中"
        "stopped" -> "未启动"
        "stopping" -> "停止中"
        "waiting_approval" -> "等待审批"
        "interrupted" -> "已中断"
        "error" -> "错误"
        else -> status
    }
}

private fun threadStatusValueColor(status: String): Color {
    return if (status == "running") {
        Color(0xFF3B82F6)
    } else {
        Color(0xFF9A9A9A)
    }
}

@Composable
private fun TopActionLabel(
    text: String,
    enabled: Boolean = true,
    onClick: () -> Unit
) {
    Text(
        text = text,
        color = if (enabled) Color(0xFF0F766E) else Color(0xFFA8B1AD),
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 2.dp)
    )
}
