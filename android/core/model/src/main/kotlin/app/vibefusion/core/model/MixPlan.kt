package app.vibefusion.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/** Platform-neutral mix plan (contracts/schemas/mix-plan.schema.json, version 1). */
@Serializable
data class MixPlan(
    val version: Int = 1,
    val title: String,
    val description: String? = null,
    val durationMs: Int,
    val tempoBpm: Double? = null,
    val snapToBeat: Boolean? = null,
    val masterGainDb: Double? = -3.0,
    val ducking: Ducking? = null,
    val layers: List<MixLayer>,
    val transitions: List<MixTransition>? = emptyList(),
    val warnings: List<String>? = null,
)

@Serializable
enum class LayerRole { @SerialName("music") MUSIC, @SerialName("speech") SPEECH, @SerialName("ambience") AMBIENCE, @SerialName("percussion") PERCUSSION, @SerialName("effect") EFFECT }

@Serializable
data class MixLayer(
    val id: String,
    val assetId: String,
    val role: LayerRole,
    val startMs: Int = 0,
    val sourceInMs: Int = 0,
    val durationMs: Int,
    val gainDb: Double = -10.0,
    val fadeInMs: Int = 2000,
    val fadeOutMs: Int = 3000,
    val loop: Boolean = false,
    val pan: Double = 0.0,
    val muted: Boolean? = null,
    val solo: Boolean? = null,
) {
    val endMs get() = startMs + durationMs
}

@Serializable
enum class TransitionCurve { @SerialName("linear") LINEAR, @SerialName("equal_power") EQUAL_POWER, @SerialName("exponential") EXPONENTIAL }

@Serializable
data class MixTransition(val fromLayerId: String, val toLayerId: String, val startMs: Int, val durationMs: Int, val curve: TransitionCurve)

@Serializable
data class Ducking(val enabled: Boolean, val amountDb: Double? = 9.0, val attackMs: Int? = 300, val releaseMs: Int? = 800)

/** Mix-plan gain semantics — a port of backend/src/fusion/envelope.ts, verified against contracts/fixtures/envelope-cases.json. */
object Envelope {
    const val DEFAULT_MASTER_GAIN_DB = -3.0
    const val DEFAULT_DUCK_DB = 9.0
    const val DEFAULT_ATTACK_MS = 300
    const val DEFAULT_RELEASE_MS = 800

    fun dbToLinear(db: Double) = 10.0.pow(db / 20.0)
    private fun clamp01(x: Double) = if (x < 0) 0.0 else if (x > 1) 1.0 else x

    fun curveIn(curve: TransitionCurve, x: Double): Double {
        val v = clamp01(x)
        return when (curve) {
            TransitionCurve.LINEAR -> v
            TransitionCurve.EXPONENTIAL -> v * v
            TransitionCurve.EQUAL_POWER -> sin(v * PI / 2)
        }
    }

    fun curveOut(curve: TransitionCurve, x: Double) = curveIn(curve, 1 - clamp01(x))

    private fun audible(plan: MixPlan, layer: MixLayer): Boolean {
        if (layer.muted == true) return false
        val anySolo = plan.layers.any { it.solo == true }
        return !anySolo || layer.solo == true
    }

    fun duckWeight(plan: MixPlan, tMs: Double): Double {
        val d = plan.ducking ?: return 0.0
        if (!d.enabled) return 0.0
        val attack = (d.attackMs ?: DEFAULT_ATTACK_MS).toDouble()
        val release = (d.releaseMs ?: DEFAULT_RELEASE_MS).toDouble()
        var w = 0.0
        for (s in plan.layers) {
            if (s.role != LayerRole.SPEECH || !audible(plan, s)) continue
            val start = s.startMs.toDouble()
            val end = (s.startMs + s.durationMs).toDouble()
            val v = when {
                tMs < start -> 0.0
                tMs >= end -> if (release > 0) 1 - (tMs - end) / release else 0.0
                else -> if (attack > 0) min(1.0, (tMs - start) / attack) else 1.0
            }
            w = max(w, clamp01(v))
        }
        return w
    }

    /** Linear amplitude gain for a layer at plan time t (excludes master gain and pan). */
    fun layerGain(plan: MixPlan, layer: MixLayer, tMs: Double): Double {
        if (!audible(plan, layer)) return 0.0
        val local = tMs - layer.startMs
        val dur = layer.durationMs.toDouble()
        if (local < 0 || local >= dur) return 0.0
        var g = dbToLinear(layer.gainDb)
        if (layer.fadeInMs > 0 && local < layer.fadeInMs) g *= curveIn(TransitionCurve.EQUAL_POWER, local / layer.fadeInMs)
        val remaining = dur - local
        if (layer.fadeOutMs > 0 && remaining < layer.fadeOutMs) g *= curveIn(TransitionCurve.EQUAL_POWER, remaining / layer.fadeOutMs)
        for (tr in plan.transitions.orEmpty()) {
            val s = tr.startMs.toDouble()
            val d = tr.durationMs.toDouble()
            if (tr.fromLayerId == layer.id && tMs >= s) g *= if (d > 0) curveOut(tr.curve, (tMs - s) / d) else 0.0
            if (tr.toLayerId == layer.id) {
                if (tMs < s) g = 0.0 else g *= if (d > 0) curveIn(tr.curve, (tMs - s) / d) else 1.0
            }
        }
        if (layer.role != LayerRole.SPEECH) {
            val w = duckWeight(plan, tMs)
            if (w > 0) g *= dbToLinear(-(plan.ducking?.amountDb ?: DEFAULT_DUCK_DB) * w)
        }
        return g
    }

    fun masterGain(plan: MixPlan) = dbToLinear(plan.masterGainDb ?: DEFAULT_MASTER_GAIN_DB)

    /** Equal-power pan law → (left, right). */
    fun panGains(pan: Double): Pair<Double, Double> {
        val p = max(-1.0, min(1.0, pan))
        val angle = (p + 1) * PI / 4
        return cos(angle) to sin(angle)
    }

    fun sourcePositionMs(layer: MixLayer, assetDurationMs: Int, tMs: Double): Double? {
        val local = tMs - layer.startMs
        if (local < 0 || local >= layer.durationMs) return null
        if (layer.loop) {
            val loopLen = (assetDurationMs - layer.sourceInMs).toDouble()
            if (loopLen <= 0) return null
            return layer.sourceInMs + (local % loopLen)
        }
        val pos = layer.sourceInMs + local
        return if (pos < assetDurationMs) pos else null
    }
}

data class ScheduledSegment(val startOffsetMs: Double, val sourceStartMs: Double, val durationMs: Double)

/** Pure scheduling (trim, loops, run-out) shared semantics with iOS FusionScheduler. */
object FusionScheduler {
    fun segments(layer: MixLayer, assetDurationMs: Int, fromMs: Double, maxSegments: Int = 2000): List<ScheduledSegment> {
        val layerStart = layer.startMs.toDouble()
        val layerEnd = (layer.startMs + layer.durationMs).toDouble()
        if (fromMs >= layerEnd || assetDurationMs <= 0) return emptyList()
        var t = max(fromMs, layerStart)
        val out = mutableListOf<ScheduledSegment>()
        while (t < layerEnd && out.size < maxSegments) {
            val src = Envelope.sourcePositionMs(layer, assetDurationMs, t) ?: break
            val len = min(assetDurationMs - src, layerEnd - t)
            if (len <= 0.5) break
            out += ScheduledSegment(t - fromMs, src, len)
            if (!layer.loop) break
            t += len
        }
        return out
    }
}

/** Instant local checks for the editor; the server stays authoritative for schema and rights. */
object MixPlanLocalCheck {
    fun issues(plan: MixPlan, maxLayers: Int = 6): List<String> = buildList {
        if (plan.layers.isEmpty()) add("Add at least one layer.")
        if (plan.layers.size > maxLayers) add("A session can have at most $maxLayers layers.")
        if (plan.layers.map { it.id }.toSet().size != plan.layers.size) add("Layer ids must be unique.")
        for (l in plan.layers) {
            if (l.startMs >= plan.durationMs) add("Layer ${l.id} starts after the session ends.")
            if (l.gainDb !in -60.0..6.0) add("Layer ${l.id} gain must be between -60 and +6 dB.")
            if (l.durationMs < 1000) add("Layer ${l.id} must last at least one second.")
        }
    }
}
