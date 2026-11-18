package app.vibefusion.core.audio

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import app.vibefusion.core.model.mix.PcmSource
import java.io.File
import java.nio.ByteOrder

/**
 * Streams a local audio file (MP3/AAC/WAV…) through MediaCodec, converting to interleaved stereo float
 * at [outRate] with linear-interpolation resampling. Memory stays bounded regardless of file length.
 */
class MediaCodecPcmSource(file: File, private val outRate: Int = 48_000) : PcmSource {
    private val extractor = MediaExtractor()
    private val codec: MediaCodec
    private var srcRate: Int
    private var channels: Int
    private var floatOutput = false
    override val durationMs: Int

    private var buf = FloatArray(16_384) // stereo interleaved at source rate
    private var bufFrames = 0
    private var readPos = 0.0
    private var inputDone = false
    private var outputDone = false
    private var discardUntilUs = -1L
    private val info = MediaCodec.BufferInfo()

    init {
        extractor.setDataSource(file.absolutePath)
        val track = (0 until extractor.trackCount).first { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)!!.startsWith("audio/") }
        extractor.selectTrack(track)
        val format = extractor.getTrackFormat(track)
        srcRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        durationMs = if (format.containsKey(MediaFormat.KEY_DURATION)) (format.getLong(MediaFormat.KEY_DURATION) / 1000).toInt() else 0
        codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
        codec.configure(format, null, null, 0)
        codec.start()
    }

    override fun seekTo(ms: Double) {
        val us = (ms * 1000).toLong()
        extractor.seekTo(us, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
        codec.flush()
        bufFrames = 0
        readPos = 0.0
        inputDone = false
        outputDone = false
        discardUntilUs = us
    }

    override fun read(out: FloatArray, frames: Int): Int {
        val ratio = srcRate.toDouble() / outRate
        var produced = 0
        while (produced < frames) {
            val i0 = readPos.toInt()
            if (i0 + 1 >= bufFrames) {
                if (outputDone) break
                compact()
                decodeMore()
                continue
            }
            val frac = (readPos - i0).toFloat()
            val a = i0 * 2
            out[produced * 2] = buf[a] + (buf[a + 2] - buf[a]) * frac
            out[produced * 2 + 1] = buf[a + 1] + (buf[a + 3] - buf[a + 1]) * frac
            produced++
            readPos += ratio
        }
        return produced
    }

    private fun compact() {
        val keep = readPos.toInt().coerceAtMost(bufFrames)
        if (keep > 0) {
            System.arraycopy(buf, keep * 2, buf, 0, (bufFrames - keep) * 2)
            bufFrames -= keep
            readPos -= keep
        }
    }

    private fun decodeMore() {
        var gotOutput = false
        var spins = 0
        while (!gotOutput && !outputDone && spins++ < 200) {
            if (!inputDone) {
                val ii = codec.dequeueInputBuffer(5_000)
                if (ii >= 0) {
                    val ib = codec.getInputBuffer(ii)!!
                    val n = extractor.readSampleData(ib, 0)
                    if (n < 0) {
                        codec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        inputDone = true
                    } else {
                        codec.queueInputBuffer(ii, 0, n, extractor.sampleTime, 0)
                        extractor.advance()
                    }
                }
            }
            val oi = codec.dequeueOutputBuffer(info, 5_000)
            when {
                oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val f = codec.outputFormat
                    srcRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                    channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                    floatOutput = f.containsKey(MediaFormat.KEY_PCM_ENCODING) && f.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
                }
                oi >= 0 -> {
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
                    if (info.size > 0) {
                        val ob = codec.getOutputBuffer(oi)!!.order(ByteOrder.nativeOrder())
                        ob.position(info.offset); ob.limit(info.offset + info.size)
                        appendPcm(ob, info.presentationTimeUs)
                        gotOutput = true
                    }
                    codec.releaseOutputBuffer(oi, false)
                }
            }
        }
    }

    private fun appendPcm(ob: java.nio.ByteBuffer, ptsUs: Long) {
        val bytesPerSample = if (floatOutput) 4 else 2
        val frames = ob.remaining() / (bytesPerSample * channels)
        var skip = 0
        if (discardUntilUs >= 0) {
            skip = (((discardUntilUs - ptsUs) * srcRate) / 1_000_000).toInt().coerceIn(0, frames)
            if (skip < frames) discardUntilUs = -1
        }
        ensure(bufFrames + frames - skip)
        for (f in 0 until frames) {
            var l: Float; var r: Float
            if (floatOutput) {
                l = ob.float; r = if (channels > 1) ob.float else l
                repeat(channels - 2) { ob.float }
            } else {
                l = ob.short / 32768f; r = if (channels > 1) ob.short / 32768f else l
                repeat(channels - 2) { ob.short }
            }
            if (f < skip) continue
            buf[bufFrames * 2] = l
            buf[bufFrames * 2 + 1] = r
            bufFrames++
        }
    }

    private fun ensure(frames: Int) { if (frames * 2 > buf.size) buf = buf.copyOf(maxOf(frames * 2, buf.size * 2)) }

    override fun close() {
        runCatching { codec.stop() }
        runCatching { codec.release() }
        runCatching { extractor.release() }
    }
}
