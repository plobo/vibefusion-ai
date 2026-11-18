package app.vibefusion.playback

import android.net.Uri
import android.os.Bundle
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import app.vibefusion.core.audio.FusionSessionPlayer
import app.vibefusion.core.model.Asset
import app.vibefusion.core.network.AuthorizeBody
import app.vibefusion.core.network.VibeFusionApi
import app.vibefusion.core.network.apiCall
import app.vibefusion.data.Analytics
import app.vibefusion.data.DownloadRepository
import app.vibefusion.data.ProgressRepository
import app.vibefusion.fusion.FusionController
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.*
import kotlinx.coroutines.guava.future
import okhttp3.OkHttpClient
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

const val ASSET_SCHEME = "vibefusion"
fun assetUri(id: String): Uri = Uri.parse("$ASSET_SCHEME://asset/$id")

fun Asset.toMediaItem(): MediaItem = MediaItem.Builder()
    .setMediaId(id)
    .setUri(assetUri(id))
    .setMediaMetadata(
        MediaMetadata.Builder().setTitle(title).setArtist(creatorName).setAlbumTitle(showTitle)
            .setArtworkUri(artworkUrl?.let(Uri::parse)).setIsPlayable(true).setIsBrowsable(false)
            .setExtras(Bundle().apply { putString("assetType", assetType); putInt("durationMs", durationMs) })
            .build(),
    ).build()

/**
 * Maps vibefusion://asset/<id> to a playable URI at load time: a licensed local download if present,
 * otherwise a fresh short-lived signed URL from the backend. URLs live only in memory and are refreshed on expiry.
 */
@Singleton
class MediaResolver @Inject constructor(private val api: VibeFusionApi, private val downloads: DownloadRepository) {
    private data class Cached(val uri: Uri, val expiresAtMs: Long)
    private val cache = ConcurrentHashMap<String, Cached>()

    fun resolveBlocking(assetId: String): Uri = runBlocking(Dispatchers.IO) {
        downloads.localFile(assetId)?.let { return@runBlocking Uri.fromFile(it) }
        cache[assetId]?.takeIf { it.expiresAtMs - System.currentTimeMillis() > 60_000 }?.let { return@runBlocking it.uri }
        val grant = apiCall(retries = 2) { api.authorize(AuthorizeBody(assetId, "stream")) }
        val exp = runCatching { java.time.Instant.parse(grant.expiresAt).toEpochMilli() }.getOrDefault(System.currentTimeMillis() + 300_000)
        Uri.parse(grant.url).also { cache[assetId] = Cached(it, exp) }
    }

    fun invalidate(assetId: String) { cache.remove(assetId) }
}

@UnstableApi
@AndroidEntryPoint
class PlaybackService : MediaLibraryService() {
    @Inject lateinit var resolver: MediaResolver
    @Inject lateinit var progress: ProgressRepository
    @Inject lateinit var fusion: FusionController
    @Inject lateinit var analytics: Analytics
    @Inject lateinit var api: VibeFusionApi

    private lateinit var exo: ExoPlayer
    private lateinit var fusionPlayer: FusionSessionPlayer
    private var session: MediaLibrarySession? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var recoveries = 0
    private var startRequestedAt = 0L

    override fun onCreate() {
        super.onCreate()
        // Media fetches go to signed/third-party URLs: use a plain client so API bearer tokens are never forwarded.
        val mediaHttp = OkHttpDataSource.Factory(OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).build())
        val upstream = DefaultDataSource.Factory(this, mediaHttp)
        val resolving = ResolvingDataSource.Factory(upstream) { spec ->
            if (spec.uri.scheme == ASSET_SCHEME) spec.withUri(resolver.resolveBlocking(spec.uri.lastPathSegment!!)) else spec
        }
        exo = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(resolving))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), /* handleAudioFocus = */ true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setSeekBackIncrementMs(15_000)
            .setSeekForwardIncrementMs(30_000)
            .build()
        exo.addListener(listener)
        fusionPlayer = FusionSessionPlayer(fusion.engine, Looper.getMainLooper())
        session = MediaLibrarySession.Builder(this, exo, libraryCallback).build()

        // One session; swap its player when a fusion session becomes active (and pause the other engine).
        scope.launch {
            fusion.active.collect { active ->
                val s = session ?: return@collect
                if (active && s.player !== fusionPlayer) { exo.pause(); s.player = fusionPlayer }
                if (!active && s.player !== exo) s.player = exo
            }
        }
        scope.launch {
            while (isActive) {
                delay(10_000)
                if (exo.isPlaying) saveProgress()
            }
        }
    }

    private fun saveProgress() {
        val item = exo.currentMediaItem ?: return
        val pos = exo.currentPosition.toInt()
        val dur = exo.duration.takeIf { it > 0 }?.toInt() ?: item.mediaMetadata.extras?.getInt("durationMs") ?: 0
        scope.launch(Dispatchers.IO) { progress.save(item.mediaId, pos, dur) }
    }

    private val listener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) {
                fusion.deactivateForStandardPlayback()
                if (startRequestedAt > 0) {
                    analytics.track("playback_started", "assetId" to (exo.currentMediaItem?.mediaId ?: ""), "latencyMs" to (System.currentTimeMillis() - startRequestedAt))
                    analytics.track("stream_start_latency", "latencyMs" to (System.currentTimeMillis() - startRequestedAt))
                    startRequestedAt = 0
                }
            } else saveProgress()
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            recoveries = 0
            startRequestedAt = System.currentTimeMillis()
            mediaItem?.let { analytics.track("asset_play_requested", "assetId" to it.mediaId) }
        }

        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_ENDED) exo.currentMediaItem?.let {
                scope.launch(Dispatchers.IO) { progress.save(it.mediaId, exo.duration.toInt(), exo.duration.toInt()) }
                analytics.track("playback_completed", "assetId" to it.mediaId)
            }
        }

        /** Expired/revoked signed URL (403/410) or transient network loss: re-authorize and resume at the same position. */
        override fun onPlayerError(error: PlaybackException) {
            val id = exo.currentMediaItem?.mediaId ?: return
            val http = generateSequence(error.cause) { it.cause }.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()
            val recoverable = http?.responseCode in setOf(401, 403, 410) || error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ||
                error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
            analytics.track("playback_failed", "assetId" to id, "errorCode" to (http?.responseCode?.toString() ?: error.errorCodeName))
            if (!recoverable || recoveries >= 3) return
            recoveries++
            resolver.invalidate(id)
            val pos = exo.currentPosition
            scope.launch {
                delay(500L * recoveries)
                exo.prepare(); exo.seekTo(pos); exo.play()
            }
        }
    }

    /** Browse tree for Android Auto / external controllers. */
    private val libraryCallback = object : MediaLibrarySession.Callback {
        private fun folder(id: String, title: String) = MediaItem.Builder().setMediaId(id)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setIsBrowsable(true).setIsPlayable(false).build()).build()

        override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> =
            Futures.immediateFuture(LibraryResult.ofItem(folder("root", "VibeFusion"), params))

        override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
            scope.future(Dispatchers.IO) {
                val items = when (parentId) {
                    "root" -> listOf(folder("speech", "Motivational speeches"), folder("music", "Free & open music"), folder("podcast_episode", "Podcast episodes"))
                    else -> runCatching { apiCall { api.catalogue(type = parentId) }.items.map { it.toMediaItem() } }.getOrDefault(emptyList())
                }
                LibraryResult.ofItemList(ImmutableList.copyOf(items), params)
            }

        override fun onAddMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>): ListenableFuture<MutableList<MediaItem>> =
            Futures.immediateFuture(mediaItems.map { if (it.localConfiguration == null) it.buildUpon().setUri(assetUri(it.mediaId)).build() else it }.toMutableList())
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    override fun onTaskRemoved(rootIntent: android.content.Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        saveProgress()
        scope.cancel()
        session?.run { player.release(); release() }
        session = null
        exo.release()
        super.onDestroy()
    }
}
