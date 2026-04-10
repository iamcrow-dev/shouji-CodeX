package com.qwe.codexmobile.model

data class ConnectionConfig(
    val host: String = "",
    val port: String = "333",
    val token: String = "",
    val workspacePath: String = "/Users/qwe/Documents/codex"
) {
    fun isComplete(): Boolean =
        host.isNotBlank() &&
            port.isNotBlank() &&
            token.isNotBlank() &&
            workspacePath.isNotBlank()
}

data class ThreadSummary(
    val id: String,
    val title: String,
    val preview: String,
    val status: String,
    val updatedAt: Long
)

data class HostStats(
    val clientCount: Int = 0,
    val pendingApprovals: Int = 0,
    val serviceStatus: String = "stopped",
    val codexReady: Boolean = false,
    val lastError: String = "",
    val workspacePath: String = ""
)

data class ChatItem(
    val id: String,
    val turnId: String,
    val type: String,
    val role: String? = null,
    val text: String = "",
    val status: String? = null,
    val timestamp: Long = 0L
)

data class ApprovalQuestion(
    val id: String,
    val label: String,
    val prompt: String,
    val options: List<String> = emptyList()
)

data class ApprovalItem(
    val requestId: String,
    val kind: String,
    val summary: String,
    val threadId: String?,
    val details: List<String> = emptyList(),
    val questions: List<ApprovalQuestion> = emptyList()
)

sealed interface HostEvent {
    data class ThreadCreated(val thread: ThreadSummary) : HostEvent
    data class ThreadUpdated(val threadId: String, val status: String) : HostEvent
    data class ThreadDeleted(val threadId: String) : HostEvent
    data class TurnStarted(val threadId: String) : HostEvent
    data class TurnCompleted(val threadId: String) : HostEvent
    data class MessageDelta(
        val threadId: String,
        val messageId: String,
        val delta: String,
        val timestamp: Long
    ) : HostEvent
    data class MessageCompleted(
        val threadId: String,
        val messageId: String,
        val text: String,
        val timestamp: Long
    ) : HostEvent
    data class ApprovalRequired(val approval: ApprovalItem) : HostEvent
    data class ApprovalResolved(val requestId: String) : HostEvent
    data class HostState(val stats: HostStats) : HostEvent
    data class ThreadError(val message: String) : HostEvent
}
