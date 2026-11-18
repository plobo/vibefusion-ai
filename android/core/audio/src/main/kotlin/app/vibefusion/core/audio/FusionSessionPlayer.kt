package app.vibefusion.core.audio

import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * Exposes [FusionEngine] as a Media3 Player so the same MediaSession (notification, lock screen,
 * Bluetooth/headset buttons, Android Auto) controls fusion sessions exactly like standard streams.
 */
@UnstableApi
class FusionSessionPlayer(private val engine: FusionEngine, looper: Looper) : SimpleBasePlayer(looper) {
    private val handler = android.os.Handler(looper)

    init {
        val previous = engine.onStateChanged
        engine.onStateChanged = {
            previous?.invoke()
            handler.post { invalidateState() }
        }
    }

    override fun getState(): State {
        val s = engine.state.value
        val commands = Player.Commands.Builder()
            .addAll(Player.COMMAND_PLAY_PAUSE, Player.COMMAND_STOP, Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
                Player.COMMAND_GET_METADATA, Player.COMMAND_GET_TIMELINE, Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD)
            .build()
        val builder = State.Builder().setAvailableCommands(commands)
        if (s.phase == FusionEngine.Phase.IDLE) {
            return builder.setPlaybackState(Player.STATE_IDLE).setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST).build()
        }
        val item = MediaItem.Builder().setMediaId("fusion-session")
            .setMediaMetadata(MediaMetadata.Builder().setTitle(s.title).setArtist("VibeFusion AI Studio").build()).build()
        return builder
            .setPlaylist(listOf(MediaItemData.Builder("fusion").setMediaItem(item).setDurationUs(s.durationMs * 1000L).setIsSeekable(true).build()))
            .setPlaybackState(if (s.phase == FusionEngine.Phase.ENDED) Player.STATE_ENDED else Player.STATE_READY)
            .setPlayWhenReady(s.phase == FusionEngine.Phase.PLAYING, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setContentPositionMs { engine.currentPositionMs().toLong() }
            .setSeekBackIncrementMs(15_000)
            .setSeekForwardIncrementMs(30_000)
            .build()
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        if (playWhenReady) engine.play() else engine.pause()
        return Futures.immediateVoidFuture()
    }

    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        val target = when (seekCommand) {
            Player.COMMAND_SEEK_BACK -> engine.currentPositionMs() - 15_000
            Player.COMMAND_SEEK_FORWARD -> engine.currentPositionMs() + 30_000
            else -> positionMs.toDouble()
        }
        engine.seek(target)
        return Futures.immediateVoidFuture()
    }

    override fun handleStop(): ListenableFuture<*> { engine.pause(); return Futures.immediateVoidFuture() }
    override fun handleRelease(): ListenableFuture<*> = Futures.immediateVoidFuture()
}
