package app.vibefusion.core.model

import app.vibefusion.core.model.mix.FusionMixer
import app.vibefusion.core.model.mix.PcmSource
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin
import kotlin.math.sqrt

private fun repoFile(rel: String): File {
    var dir: File? = File("").absoluteFile
    while (dir != null && !File(dir, "contracts").isDirectory) dir = dir.parentFile
    return File(dir ?: error("repo root not found"), rel)
}

/** Kotlin envelope must reproduce contracts/fixtures/envelope-cases.json (generated from the TypeScript reference). */
class EnvelopeFixtureTest {
    @Test
    fun envelopeMatchesSharedFixtures() {
        val root = VfJson.parseToJsonElement(repoFile("contracts/fixtures/envelope-cases.json").readText()).jsonObject
        val tol = root["tolerance"]!!.jsonPrimitive.double
        var checked = 0
        for (c in root["cases"]!!.jsonArray) {
            val obj = c.jsonObject
            val name = obj["name"]!!.jsonPrimitive.content
            val plan = VfJson.decodeFromJsonElement(MixPlan.serializer(), obj["plan"]!!)
            val durations = obj["assetDurationsMs"]!!.jsonObject.mapValues { it.value.jsonPrimitive.int }
            assertEquals(name, obj["masterGain"]!!.jsonPrimitive.double, Envelope.masterGain(plan), tol)
            for (l in plan.layers) {
                val pan = obj["pan"]!!.jsonObject[l.id]!!.jsonArray
                val (pl, pr) = Envelope.panGains(l.pan)
                assertEquals(pan[0].jsonPrimitive.double, pl, tol)
                assertEquals(pan[1].jsonPrimitive.double, pr, tol)
            }
            for (s in obj["samples"]!!.jsonArray) {
                val so = s.jsonObject
                val t = so["tMs"]!!.jsonPrimitive.double
                assertEquals("$name duck@$t", so["duckWeight"]!!.jsonPrimitive.double, Envelope.duckWeight(plan, t), tol)
                val gains = so["gains"] as JsonObject
                val positions = so["sourcePositionsMs"] as JsonObject
                for (l in plan.layers) {
                    assertEquals("$name ${l.id}@$t", gains[l.id]!!.jsonPrimitive.double, Envelope.layerGain(plan, l, t), tol)
                    val expected = positions[l.id]
                    val actual = Envelope.sourcePositionMs(l, durations[l.assetId] ?: 0, t)
                    if (expected == null || expected is JsonNull) assertNull(actual) else assertEquals(expected.jsonPrimitive.double, actual!!, 0.001)
                    checked++
                }
            }
        }
        assertTrue(checked > 50)
    }

    @Test
    fun validPlanFixtureRoundTrips() {
        val plan = VfJson.decodeFromString(MixPlan.serializer(), repoFile("contracts/fixtures/mix-plan-valid.json").readText())
        assertEquals(3, plan.layers.size)
        assertTrue(MixPlanLocalCheck.issues(plan).isEmpty())
        assertEquals(plan, VfJson.decodeFromString(MixPlan.serializer(), VfJson.encodeToString(MixPlan.serializer(), plan)))
        assertTrue(VfJson.encodeToString(MixPlan.serializer(), plan).contains("\"role\":\"speech\""))
    }
}

class SchedulerAndQueueTest {
    private fun a(id: String) = Asset(id = id, title = id, assetType = "music", durationMs = 1000)

    @Test
    fun loopingLayerProducesContiguousSegments() {
        val l = MixLayer("a", "x", LayerRole.MUSIC, startMs = 10_000, sourceInMs = 2000, durationMs = 50_000, loop = true)
        val segs = FusionScheduler.segments(l, 16_000, 0.0)
        assertEquals(ScheduledSegment(10_000.0, 2000.0, 14_000.0), segs.first())
        assertEquals(50_000.0, segs.sumOf { it.durationMs }, 0.01)
        segs.zipWithNext().forEach { (x, y) -> assertEquals(x.startOffsetMs + x.durationMs, y.startOffsetMs, 0.01) }
    }

    @Test
    fun nonLoopingRunsOut() {
        val l = MixLayer("a", "x", LayerRole.SPEECH, durationMs = 60_000)
        assertEquals(listOf(ScheduledSegment(0.0, 0.0, 40_000.0)), FusionScheduler.segments(l, 40_000, 0.0))
        assertTrue(FusionScheduler.segments(l, 40_000, 45_000.0).isEmpty())
    }

    @Test
    fun queueRepeatAndShuffle() {
        var q = PlaybackQueue(listOf(a("1"), a("2"), a("3")), cursor = 1)
        q = q.next(false)!!
        assertEquals("3", q.current?.id)
        assertNull(q.next(false))
        q = q.copy(repeatMode = RepeatMode.ALL).next(false)!!
        assertEquals("1", q.current?.id)
        val s1 = PlaybackQueue((0 until 10).map { a("$it") }, cursor = 4).withShuffle(true, 42)
        val s2 = PlaybackQueue((0 until 10).map { a("$it") }, cursor = 4).withShuffle(true, 42)
        assertEquals("4", s1.current?.id)
        assertEquals(s1.upNext, s2.upNext)
        assertEquals("4", s1.withShuffle(false).current?.id)
    }

    @Test
    fun audioPolicies() {
        assertEquals(AudioPolicy.Action.PAUSE, AudioPolicy.onBecomingNoisy(true))
        assertEquals(AudioPolicy.Action.RESUME, AudioPolicy.onFocusGain(true))
        assertEquals(AudioPolicy.Action.DUCK, AudioPolicy.onFocusLoss(canDuck = true))
    }
}

/** Sine source at the mixer rate (stands in for MediaCodec decoding in JVM tests). */
private class SineSource(val freq: Double, override val durationMs: Int, val sr: Int = 48_000, val amp: Float = 0.5f) : PcmSource {
    var pos = 0L
    val total = durationMs.toLong() * sr / 1000
    override fun seekTo(ms: Double) { pos = (ms * sr / 1000).toLong() }
    override fun read(out: FloatArray, frames: Int): Int {
        val n = minOf(frames.toLong(), total - pos).toInt().coerceAtLeast(0)
        for (i in 0 until n) { val v = (amp * sin(2 * PI * freq * (pos + i) / sr)).toFloat(); out[i * 2] = v; out[i * 2 + 1] = v }
        pos += n
        return n
    }
}

class FusionMixerTest {
    private fun rms(buf: FloatArray, from: Int, to: Int): Double {
        var s = 0.0
        for (i in from * 2 until to * 2) s += buf[i] * buf[i].toDouble()
        return sqrt(s / ((to - from) * 2))
    }

    private fun renderAll(m: FusionMixer): FloatArray {
        val out = FloatArray(m.durationFrames.toInt() * 2)
        val block = FloatArray(4800 * 2)
        var off = 0
        while (!m.isFinished) {
            val n = minOf(4800, (m.durationFrames - m.positionFrames).toInt())
            m.render(block, n)
            System.arraycopy(block, 0, out, off * 2, n * 2)
            off += n
        }
        return out
    }

    @Test
    fun layersStartOnTimeLoopAndDuckUnderSpeech() {
        val sr = 48_000
        val plan = MixPlan(
            title = "t", durationMs = 12_000, masterGainDb = 0.0,
            ducking = Ducking(true, amountDb = 12.0, attackMs = 0, releaseMs = 0),
            layers = listOf(
                MixLayer("bed", "bed", LayerRole.MUSIC, durationMs = 12_000, gainDb = 0.0, fadeInMs = 0, fadeOutMs = 0, loop = true),
                MixLayer("v", "voice", LayerRole.SPEECH, startMs = 6000, durationMs = 3000, gainDb = -60.0, fadeInMs = 0, fadeOutMs = 0),
            ),
        )
        val m = FusionMixer(plan, mapOf("bed" to SineSource(220.0, 4000), "v" to SineSource(880.0, 3000)), sr)
        val out = renderAll(m)
        val before = rms(out, sr * 1, sr * 3)
        val looped = rms(out, (sr * 4.5).toInt(), (sr * 5.5).toInt())
        val ducked = rms(out, (sr * 6.5).toInt(), (sr * 8.5).toInt()) // speech at -60 dB: what remains is the ducked bed
        val after = rms(out, sr * 10, (sr * 11.5).toInt())
        assertTrue(before > 0.1)
        assertEquals(before, looped, before * 0.05)
        assertEquals(before * Envelope.dbToLinear(-12.0), ducked, before * 0.05)
        assertEquals(before, after, before * 0.05)
    }

    @Test
    fun seekResumesMidLoopAndPeaksStayBounded() {
        val plan = MixPlan(
            title = "t", durationMs = 10_000, masterGainDb = 6.0,
            layers = (1..4).map { MixLayer("l$it", "a$it", LayerRole.MUSIC, durationMs = 10_000, gainDb = 6.0, fadeInMs = 0, fadeOutMs = 0, loop = true) },
        )
        val m = FusionMixer(plan, (1..4).associate { "l$it" to SineSource(110.0 * it, 2500, amp = 1f) })
        m.seek(7_300.0)
        assertEquals(7_300.0, m.positionMs, 0.1)
        val buf = FloatArray(48_000 * 2)
        m.render(buf, 48_000)
        assertTrue("limiter must keep samples below full scale", buf.all { abs(it) < 1f })
        assertTrue(m.peak > 0.85f)
    }

    @Test
    fun muteAndSoloSilence() {
        val plan = MixPlan(title = "t", durationMs = 2000, masterGainDb = 0.0, layers = listOf(
            MixLayer("a", "a", LayerRole.MUSIC, durationMs = 2000, gainDb = 0.0, fadeInMs = 0, fadeOutMs = 0, muted = true),
        ))
        val m = FusionMixer(plan, mapOf("a" to SineSource(440.0, 2000)))
        val out = renderAll(m)
        assertEquals(0.0, rms(out, 0, 96_000), 1e-9)
    }
}
