package com.qwe.codexmobile.data

import android.content.Context
import com.qwe.codexmobile.model.ConnectionConfig

class HostPreferences(context: Context) {
    private val preferences = context.getSharedPreferences("codex_mobile", Context.MODE_PRIVATE)
    private val defaultWorkspacePath = "/Users/qwe/Documents/codex"

    fun load(): ConnectionConfig {
        return ConnectionConfig(
            host = preferences.getString("host", "") ?: "",
            port = preferences.getString("port", "333") ?: "333",
            token = preferences.getString("token", "") ?: "",
            workspacePath = preferences.getString("workspacePath", defaultWorkspacePath) ?: defaultWorkspacePath
        )
    }

    fun save(config: ConnectionConfig) {
        preferences.edit()
            .putString("host", config.host.trim())
            .putString("port", config.port.trim())
            .putString("token", config.token.trim())
            .putString("workspacePath", config.workspacePath.trim())
            .apply()
    }
}
