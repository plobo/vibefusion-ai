package app.vibefusion.playback

import android.content.ComponentName
import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.vibefusion.core.model.Asset
import app.vibefusion.core.model.RepeatMode
import app.vibefusion.core.model.SleepTimer
import app.vibefusion.data.ProgressRepository
import com.google.common.util.concurrent.MoreExecutors
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject
import javax.inject.Singleton

data class PlayerUiState(
    val current: Asset? = null,
    val isPlaying: Boolean = false,
    val isBuffering: Boolean = false,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val speed: Float = 1f,
    val shuffle: Boolean = false,
    val repeat: RepeatMode = RepeatMode.OFF,
    val upNext: List<Asset> = emptyList(),
    val error: String? = null,
    val sleepTimer: SleepTimer = SleepTimer.Off,
    val sleepRemainingSec: Int? = null,
)

/** UI-side controller: talks to [PlaybackService] through a Media3 MediaController (process-safe, OS-integrated). */
@UnstableApi
@Singleton
class PlaybackConnection @Inject constructor(@ApplicationContext private val context: Context, private val progress: ProgressRepository) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val _state = MutableStateFlow(PlayerUiState())
    val state: StateFlow<PlayerUiState> = _state.asStateFlow()
    private var controller: MediaController? = null
    private val assets = HashMap<String, Asset>()
    private var sleepJob: Job? = null
    private val pending = mutableListOf<(MediaController) -> Unit>()

    init {
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        future.addListener({
            val c = future.get()
            controller = c
            c.addListener(object : Player.Listener {
                override fun onEvents(player: Player, events: Player.Events) = sync()
            })
            pending.forEach { it(c) }; pending.clear()
            sync()
        }, MoreExecutors.directExecutor())
        scope.launch { while (isActive) { delay(500); if (_state.value.isPlaying) sync() } }
    }

    private fun withController(block: (MediaController) -> Unit) { controller?.let(block) ?: pending.add(block) }

    private fun sync() {
        val c = controller ?: return
        val id = c.currentMediaItem?.mediaId
        val isStandard = id != null && id != "fusion-session"
        val upNext = if (isStandard) (c.currentMediaItemIndex + 1 until c.mediaItemCount).mapNotNull { assets[c.getMediaItemAt(it).mediaId] } else emptyList()
        _state.update {
            it.copy(
                current = if (isStandard) assets[id] else null,
                isPlaying = c.isPlaying && isStandard,
                isBuffering = c.playbackState == Player.STATE_BUFFERING,
                positionMs = c.currentPosition,
                durationMs = c.duration.takeIf { d -> d > 0 } ?: (assets[id]?.durationMs?.toLong() ?: 0),
                speed = c.playbackParameters.speed,
                shuffle = c.shuffleModeEnabled,
                repeat = when (c.repeatMode) { Player.REPEAT_MODE_ALL -> RepeatMode.ALL; Player.REPEAT_MODE_ONE -> RepeatMode.ONE; else -> RepeatMode.OFF },
                upNext = upNext,
                error = c.playerError?.let { e -> "Playback problem: ${e.errorCodeName.removePrefix("ERROR_CODE_").lowercase().replace('_', ' ')}" },
            )
        }
    }

    /** Starts a queue; resumes the first item from its last persisted position. */
    fun play(items: List<Asset>, startIndex: Int = 0) {
        val playable = items.filter { it.capabilities.stream && it.isActive }
        if (playable.isEmpty()) return
        playable.forEach { assets[it.id] = it }
        val start = playable.indexOfFirst { it.id == items.getOrNull(startIndex)?.id }.coerceAtLeast(0)
        scope.launch {
            val resume = withContext(Dispatchers.IO) { progress.resumePosition(playable[start].id) }
            withController { c ->
                c.setMediaItems(playable.map { it.toMediaItem() }, start, resume.toLong())
                c.setPlaybackSpeed(1f)
                c.prepare(); c.play()
            }
        }
    }

    fun enqueue(asset: Asset, next: Boolean) {
        assets[asset.id] = asset
        withController { c ->
            if (c.mediaItemCount == 0) { play(listOf(asset)); return@withController }
            if (next) c.addMediaItem(c.currentMediaItemIndex + 1, asset.toMediaItem()) else c.addMediaItem(asset.toMediaItem())
        }
    }

    fun toggle() = withController { if (it.isPlaying) it.pause() else it.play() }
    fun pause() = withController { it.pause() }
    fun seekTo(ms: Long) = withController { it.seekTo(ms); sync() }
    fun skip(seconds: Int) = withController { it.seekTo((it.currentPosition + seconds * 1000L).coerceAtLeast(0)) }
    fun next() = withController { it.seekToNextMediaItem() }
    fun previous() = withController { if (it.currentPosition > 3000) it.seekTo(0) else it.seekToPreviousMediaItem() }
    fun setSpeed(s: Float) = withController { it.setPlaybackSpeed(s) }
    fun toggleShuffle() = withController { it.shuffleModeEnabled = !it.shuffleModeEnabled }
    fun cycleRepeat() = withController {
        it.repeatMode = when (it.repeatMode) { Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL; Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE; else -> Player.REPEAT_MODE_OFF }
    }
    fun jumpToUpNext(i: Int) = withController { it.seekTo(it.currentMediaItemIndex + 1 + i, 0); it.play() }
    fun removeUpNext(i: Int) = withController { it.removeMediaItem(it.currentMediaItemIndex + 1 + i) }
    fun moveUpNext(from: Int, to: Int) = withController { val base = it.currentMediaItemIndex + 1; it.moveMediaItem(base + from, base + to) }

    fun setSleepTimer(t: SleepTimer) {
        sleepJob?.cancel()
        _state.update { it.copy(sleepTimer = t, sleepRemainingSec = null) }
        when (t) {
            is SleepTimer.Minutes -> sleepJob = scope.launch {
                var rem = t.minutes * 60
                while (rem > 0) { _state.update { it.copy(sleepRemainingSec = rem) }; delay(1000); rem-- }
                pause(); _state.update { it.copy(sleepTimer = SleepTimer.Off, sleepRemainingSec = null) }
            }
            SleepTimer.EndOfItem -> sleepJob = scope.launch {
                val id = _state.value.current?.id
                while (isActive) { delay(500); val s = _state.value; if (s.current?.id != id || (s.durationMs > 0 && s.positionMs >= s.durationMs - 700)) { pause(); break } }
                _state.update { it.copy(sleepTimer = SleepTimer.Off) }
            }
            SleepTimer.Off -> {}
        }
    }

    fun register(asset: Asset) { assets[asset.id] = asset }
}

private fun MediaItem.id() = mediaId
