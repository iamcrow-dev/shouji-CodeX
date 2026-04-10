package com.qwe.codexmobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import com.qwe.codexmobile.ui.HostMobileApp
import com.qwe.codexmobile.ui.theme.CodexMobileTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            CodexMobileTheme {
                HostMobileApp()
            }
        }
    }
}
