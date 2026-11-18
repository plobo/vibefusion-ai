package app.vibefusion

import android.app.Application
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.ViewModel
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.util.UnstableApi
import app.vibefusion.core.designsystem.VibeFusionTheme
import app.vibefusion.core.network.VibeFusionApi
import app.vibefusion.data.*
import app.vibefusion.fusion.FusionController
import app.vibefusion.playback.PlaybackConnection
import app.vibefusion.ui.AppRoot
import dagger.hilt.android.AndroidEntryPoint
import dagger.hilt.android.HiltAndroidApp
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltAndroidApp
class VibeFusionApplication : Application()

/** Shared dependencies for screens (MVVM: stateful screens get dedicated ViewModels; simple screens load through these seams). */
@UnstableApi
class Env @Inject constructor(
    val api: VibeFusionApi,
    val session: SessionRepository,
    val library: LibraryRepository,
    val downloads: DownloadRepository,
    val progress: ProgressRepository,
    val analytics: Analytics,
    val playback: PlaybackConnection,
    val fusion: FusionController,
    val settings: Settings,
) {
    val toasts = MutableSharedFlow<String>(extraBufferCapacity = 4)
    fun toast(msg: String) { toasts.tryEmit(msg) }
}

@UnstableApi
@HiltViewModel
class MainViewModel @Inject constructor(val env: Env) : ViewModel()

@UnstableApi
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject lateinit var env: Env

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Dark theme everywhere: light status/navigation bar icons.
        enableEdgeToEdge(SystemBarStyle.dark(android.graphics.Color.TRANSPARENT), SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        lifecycleScope.launch { env.session.bootstrap(); env.library.refresh(); env.progress.flush() }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { lifecycleScope.launch { env.library.refresh(); env.progress.flush() } }
            override fun onStop(owner: LifecycleOwner) { lifecycleScope.launch { env.analytics.flush() } }
        })
        setContent { VibeFusionTheme { AppRoot(deepLink = intent?.data) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setContent { VibeFusionTheme { AppRoot(deepLink = intent.data) } }
    }
}
