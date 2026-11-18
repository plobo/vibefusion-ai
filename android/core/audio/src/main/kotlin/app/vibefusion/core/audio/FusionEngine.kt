package app.vibefusion.core.audio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.Process
import app.vibefusion.core.model.AudioPolicy
import app.vibefusion.core.model.MixPlan
import app.vibefusion.core.model.mix.FusionMixer
import app.vibefusion.core.model.mix.WavWriter
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.io.RandomAccessFile

/**
 * Synchronized multi-layer engine: one MediaCodec decoder per layer → [FusionMixer] → a single float AudioTrack.
 * All layers share one sample clock, so pause/seek/resume are inherently in sync. Handles audio focus,
 * becoming-noisy (headphones unplugged / Bluetooth lost) and deterministic resource release.
 */
class FusionEngine(private val context: Context) {
    enum class Phase { IDLE, READY, PLAYING, PAUSED, ENDED, FAILED }
    data class State(
        val phase: Phase = Phase.IDLE,
        val positionMs: Double = 0.0,
        val durationMs: Int = 0,
        val title: String = "",
        val levels: Map<String, Double> = emptyMap(),
        val duckActive: Boolean = false,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()
    val plan: MixPlan? get() = mixer?.plan

    private val sampleRate = 48_000
    private val block = 1024
    private val lock = Object()
    private var mixer: FusionMixer? = null
    private var track: AudioTrack? = null
    private var thread: Thread? = null
    @Volatile private var running = false
    @Volatile private var playing = false
    private var basePositionMs = 0.0
    private var wasPlayingBeforeFocusLoss = false
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var focusRequest: AudioFocusRequest? = null
    var onBecameActive: (() -> Unit)? = null
    var onStateChanged: (() -> Unit)? = null

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            if (AudioPolicy.onBecomingNoisy(playing) == AudioPolicy.Action.PAUSE) pause()
        }
    }
    private var noisyRegistered = false

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                wasPlayingBeforeFocusLoss = playing
                pause(abandonFocus = change == AudioManager.AUDIOFOCUS_LOSS)
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> track?.setVolume(0.3f)
            AudioManager.AUDIOFOCUS_GAIN -> {
                track?.setVolume(1f)
                if (AudioPolicy.onFocusGain(wasPlayingBeforeFocusLoss) == AudioPolicy.Action.RESUME) play()
                wasPlayingBeforeFocusLoss = false
            }
        }
    }

    /** [files] maps assetId → local file (downloaded via signed URLs from the backend only). */
    fun prepare(plan: MixPlan, files: Map<String, File>) {
        release()
        try {
            val sources = plan.layers.mapNotNull { l -> files[l.assetId]?.let { l.id to MediaCodecPcmSource(it, sampleRate) } }.toMap()
            mixer = FusionMixer(plan, sources, sampleRate)
            val minBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_FLOAT)
            track = AudioTrack.Builder()
                .setAudioAttributes(attributes)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(sampleRate).setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build())
                .setBufferSizeInBytes(maxOf(minBuf, block * 2 * 4 * 4))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            basePositionMs = 0.0
            running = true
            thread = Thread(::loop, "vf-fusion-mixer").apply { start() }
            emit(Phase.READY)
        } catch (e: Exception) {
            android.util.Log.e("VibeFusion", "fusion prepare failed", e)
            release()
            _state.value = State(phase = Phase.FAILED, error = "Couldn't prepare the mix: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()

    fun play() {
        val t = track ?: return
        if (!requestFocus()) return
        onBecameActive?.invoke()
        synchronized(lock) {
            if (mixer?.isFinished == true) { mixer?.seek(0.0); t.flush(); basePositionMs = 0.0 }
            playing = true
            t.play()
            lock.notifyAll()
        }
        if (!noisyRegistered) {
            if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), Context.RECEIVER_NOT_EXPORTED)
            else @Suppress("UnspecifiedRegisterReceiverFlag") context.registerReceiver(noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
            noisyRegistered = true
        }
        emit(Phase.PLAYING)
    }

    fun pause(abandonFocus: Boolean = false) {
        val t = track ?: return
        synchronized(lock) {
            basePositionMs = currentPositionMs()
            playing = false
            t.pause(); t.flush()
            mixer?.seek(basePositionMs)
        }
        if (abandonFocus) abandonFocus()
        emit(Phase.PAUSED)
    }

    fun toggle() = if (playing) pause() else play()

    fun seek(ms: Double) {
        val t = track ?: return
        synchronized(lock) {
            val target = ms.coerceIn(0.0, (mixer?.plan?.durationMs ?: 0).toDouble())
            val wasPlaying = playing
            if (wasPlaying) t.pause()
            t.flush()
            mixer?.seek(target)
            basePositionMs = target
            if (wasPlaying) t.play()
        }
        emit(_state.value.phase)
    }

    /** Live edits from the editor: gains/fades/mute apply on the next block; timing changes re-seek sources. */
    fun update(plan: MixPlan) { synchronized(lock) { mixer?.update(plan) }; emit(_state.value.phase) }

    fun currentPositionMs(): Double {
        val t = track ?: return basePositionMs
        return basePositionMs + t.playbackHeadPosition.toLong() * 1000.0 / sampleRate
    }

    private fun loop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
        val buf = FloatArray(block * 2)
        var tick = 0
        while (running) {
            val n: Int
            synchronized(lock) {
                while (running && !playing) lock.wait(200)
                if (!running) return
                val m = mixer ?: return
                if (m.isFinished) {
                    n = -1
                } else {
                    n = minOf(block.toLong(), m.durationFrames - m.positionFrames).toInt()
                    m.render(buf, n)
                }
            }
            if (n < 0) {
                Thread.sleep(150) // let the track drain
                synchronized(lock) { playing = false; track?.pause(); basePositionMs = (mixer?.plan?.durationMs ?: 0).toDouble(); track?.flush() }
                emit(Phase.ENDED)
                continue
            }
            val written = track?.write(buf, 0, n * 2, AudioTrack.WRITE_BLOCKING) ?: 0
            if (written < 0) { emit(Phase.FAILED, "Audio output error ($written)"); playing = false }
            if (++tick % 8 == 0) emit(_state.value.phase)
        }
    }

    private fun emit(phase: Phase, error: String? = null) {
        val m = mixer
        _state.value = State(
            phase = phase,
            positionMs = if (phase == Phase.PLAYING) currentPositionMs() else basePositionMs,
            durationMs = m?.plan?.durationMs ?: 0,
            title = m?.plan?.title ?: "",
            levels = m?.levels?.toMap() ?: emptyMap(),
            duckActive = m?.duckActive ?: false,
            error = error,
        )
        onStateChanged?.invoke()
    }

    private fun requestFocus(): Boolean {
        val req = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attributes).setOnAudioFocusChangeListener(focusListener).setWillPauseWhenDucked(false).build().also { focusRequest = it }
        return audioManager.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonFocus() { focusRequest?.let { audioManager.abandonAudioFocusRequest(it) } }

    /** Stops the thread and frees codecs, AudioTrack and receivers deterministically. */
    fun release() {
        running = false
        synchronized(lock) { playing = false; lock.notifyAll() }
        thread?.join(1000)
        thread = null
        track?.run { runCatching { stop() }; release() }
        track = null
        mixer?.close()
        mixer = null
        if (noisyRegistered) { runCatching { context.unregisterReceiver(noisyReceiver) }; noisyRegistered = false }
        abandonFocus()
        _state.value = State()
        onStateChanged?.invoke()
    }

    companion object {
        /** Offline render (Phase 6) to 16-bit WAV, faster than realtime, on a background thread. */
        fun renderOffline(plan: MixPlan, files: Map<String, File>, out: File, onProgress: (Double) -> Unit = {}) {
            val sr = 44_100
            val sources = plan.layers.mapNotNull { l -> files[l.assetId]?.let { l.id to MediaCodecPcmSource(it, sr) } }.toMap()
            val mixer = FusionMixer(plan, sources, sr)
            val buf = FloatArray(4096 * 2)
            RandomAccessFile(out, "rw").use { raf ->
                raf.setLength(0)
                raf.write(ByteArray(44))
                var bytes = 0
                while (!mixer.isFinished) {
                    val n = minOf(4096L, mixer.durationFrames - mixer.positionFrames).toInt()
                    mixer.render(buf, n)
                    val pcm = WavWriter.toPcm16(buf, n * 2)
                    raf.write(pcm)
                    bytes += pcm.size
                    onProgress(mixer.positionFrames.toDouble() / mixer.durationFrames)
                }
                raf.seek(0)
                raf.write(WavWriter.header(bytes, sr))
            }
            mixer.close()
        }
    }
}
