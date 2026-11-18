package app.vibefusion.core.model.mix

import app.vibefusion.core.model.Envelope
import app.vibefusion.core.model.MixLayer
import app.vibefusion.core.model.MixPlan
import kotlin.math.abs
import kotlin.math.sign
import kotlin.math.tanh

/** Decoded, resampled audio for one asset: interleaved stereo float at the mixer's sample rate. */
interface PcmSource {
    /** Actual decoded length (authoritative for loop maths). */
    val durationMs: Int
    fun seekTo(ms: Double)
    /** Fills [out] with up to [frames] stereo frames from the current position; returns frames produced (fewer at end of stream). */
    fun read(out: FloatArray, frames: Int): Int
    fun close() {}
}

/**
 * Deterministic multi-layer mixer shared by realtime playback (AudioTrack) and offline render (WAV).
 * Gain automation is evaluated at block edges and ramped per sample, so fades/ducking are click-free.
 * Block-quantised layer starts are accurate to blockFrames / sampleRate (≈5 ms at 256 frames / 48 kHz).
 */
class FusionMixer(
    plan: MixPlan,
    private val sources: Map<String, PcmSource>, // by layer id
    val sampleRate: Int = 48_000,
    private val blockFrames: Int = 256,
) {
    @Volatile var plan: MixPlan = plan
        private set
    var positionFrames: Long = 0
        private set
    val positionMs: Double get() = positionFrames * 1000.0 / sampleRate
    val durationFrames: Long get() = plan.durationMs.toLong() * sampleRate / 1000
    val isFinished get() = positionFrames >= durationFrames

    private val needsSeek = HashMap<String, Boolean>()
    private val exhausted = HashMap<String, Boolean>()
    private val scratch = FloatArray(blockFrames * 2)
    /** Last computed linear gain per layer (for UI meters). */
    val levels = HashMap<String, Double>()
    var duckActive = false
        private set
    var peak = 0f
        private set

    init { markAllForSeek() }

    private fun markAllForSeek() { plan.layers.forEach { needsSeek[it.id] = true; exhausted[it.id] = false } }

    fun seek(ms: Double) {
        positionFrames = (ms.coerceIn(0.0, plan.durationMs.toDouble()) * sampleRate / 1000).toLong()
        markAllForSeek()
    }

    /** Live edit. Timing/structure changes force re-seeking each source from the current playhead. */
    fun update(newPlan: MixPlan) {
        val timing = { p: MixPlan -> p.layers.map { listOf(it.id, it.assetId, it.startMs, it.sourceInMs, it.durationMs, it.loop) } }
        val changed = timing(newPlan) != timing(plan)
        plan = newPlan
        if (changed) markAllForSeek()
    }

    /** Renders [frames] interleaved stereo frames into [out] and advances the playhead. */
    fun render(out: FloatArray, frames: Int) {
        java.util.Arrays.fill(out, 0, frames * 2, 0f)
        var done = 0
        while (done < frames) {
            val n = minOf(blockFrames, frames - done)
            renderBlock(out, done * 2, n)
            done += n
            positionFrames += n
        }
        val master = Envelope.masterGain(plan).toFloat()
        var pk = 0f
        for (i in 0 until frames * 2) {
            val v = softLimit(out[i] * master)
            out[i] = v
            val a = abs(v)
            if (a > pk) pk = a
        }
        peak = pk
    }

    private fun renderBlock(out: FloatArray, offset: Int, n: Int) {
        val p = plan
        val t0 = positionFrames * 1000.0 / sampleRate
        val t1 = (positionFrames + n) * 1000.0 / sampleRate
        duckActive = Envelope.duckWeight(p, t0) > 0.01
        for (layer in p.layers) {
            val src = sources[layer.id] ?: continue
            val g0 = Envelope.layerGain(p, layer, t0)
            val g1 = Envelope.layerGain(p, layer, t1)
            levels[layer.id] = g0
            val srcPos = Envelope.sourcePositionMs(layer, src.durationMs, t0)
            if (srcPos == null) { needsSeek[layer.id] = true; continue }
            if (needsSeek[layer.id] != false) {
                src.seekTo(srcPos)
                needsSeek[layer.id] = false
                exhausted[layer.id] = false
            }
            if (exhausted[layer.id] == true) continue
            val got = fill(layer, src, n)
            if (g0 == 0.0 && g1 == 0.0) continue
            val (pl, pr) = Envelope.panGains(layer.pan)
            val step = (g1 - g0) / n
            for (i in 0 until got) {
                val g = (g0 + step * i).toFloat()
                out[offset + i * 2] += scratch[i * 2] * g * pl.toFloat() * PAN_NORM
                out[offset + i * 2 + 1] += scratch[i * 2 + 1] * g * pr.toFloat() * PAN_NORM
            }
        }
    }

    /** Reads n frames for a layer, wrapping loops back to sourceIn at end of stream. */
    private fun fill(layer: MixLayer, src: PcmSource, n: Int): Int {
        var got = 0
        var guard = 0
        while (got < n && guard++ < 4) {
            val tmp = if (got == 0) scratch else FloatArray((n - got) * 2)
            val r = src.read(tmp, n - got)
            if (got > 0) System.arraycopy(tmp, 0, scratch, got * 2, r * 2)
            got += r
            if (got < n) {
                if (layer.loop) src.seekTo(layer.sourceInMs.toDouble()) else { exhausted[layer.id] = true; break }
            }
        }
        if (got < n) java.util.Arrays.fill(scratch, got * 2, n * 2, 0f)
        return n
    }

    fun close() { sources.values.forEach { it.close() } }

    companion object {
        /** Equal-power pan gives √½ per side at centre; normalise so a centred layer keeps unity gain per channel. */
        const val PAN_NORM = 1.41421356f
        private const val KNEE = 0.89f // ≈ -1 dBFS
        private const val CEILING = 0.98f // never reaches full scale

        /** Conservative peak protection: transparent below the knee, smoothly saturating to < 1.0 above it. */
        fun softLimit(x: Float): Float {
            val a = abs(x)
            if (a <= KNEE) return x
            val range = CEILING - KNEE
            val over = (a - KNEE) / range
            return sign(x) * minOf(CEILING, KNEE + range * tanh(over.toDouble()).toFloat())
        }
    }
}

/** Writes 16-bit PCM WAV (used by offline render on device). */
object WavWriter {
    fun header(dataBytes: Int, sampleRate: Int, channels: Int = 2): ByteArray {
        val b = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        b.put("RIFF".toByteArray()); b.putInt(36 + dataBytes); b.put("WAVE".toByteArray())
        b.put("fmt ".toByteArray()); b.putInt(16); b.putShort(1); b.putShort(channels.toShort())
        b.putInt(sampleRate); b.putInt(sampleRate * channels * 2); b.putShort((channels * 2).toShort()); b.putShort(16)
        b.put("data".toByteArray()); b.putInt(dataBytes)
        return b.array()
    }

    fun toPcm16(src: FloatArray, count: Int): ByteArray {
        val bb = java.nio.ByteBuffer.allocate(count * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until count) bb.putShort((src[i].coerceIn(-1f, 1f) * 32767).toInt().toShort())
        return bb.array()
    }
}
