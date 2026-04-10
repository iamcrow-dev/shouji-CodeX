package com.qwe.codexmobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val AppColors = lightColorScheme(
    primary = androidx.compose.ui.graphics.Color(0xFF0F766E),
    secondary = androidx.compose.ui.graphics.Color(0xFFB45309),
    background = androidx.compose.ui.graphics.Color(0xFFF7F1E4),
    surface = androidx.compose.ui.graphics.Color(0xFFFFF9EF),
    onPrimary = androidx.compose.ui.graphics.Color.White,
    onBackground = androidx.compose.ui.graphics.Color(0xFF1F2A26),
    onSurface = androidx.compose.ui.graphics.Color(0xFF1F2A26)
)

@Composable
fun CodexMobileTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = AppColors,
        content = content
    )
}
