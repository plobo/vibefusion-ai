import Foundation

/// Mix-plan gain semantics — a line-for-line port of backend/src/fusion/envelope.ts.
/// Verified against contracts/fixtures/envelope-cases.json in VFCoreTests.
public enum Envelope {
    public static let defaultMasterGainDb = -3.0
    public static let defaultDuckDb = 9.0
    public static let defaultAttackMs = 300
    public static let defaultReleaseMs = 800

    @inline(__always) public static func dbToLinear(_ db: Double) -> Double { pow(10, db / 20) }
    @inline(__always) static func clamp01(_ x: Double) -> Double { x < 0 ? 0 : (x > 1 ? 1 : x) }

    public static func curveIn(_ curve: TransitionCurve, _ x: Double) -> Double {
        let v = clamp01(x)
        switch curve {
        case .linear: return v
        case .exponential: return v * v
        case .equalPower: return sin(v * .pi / 2)
        }
    }

    public static func curveOut(_ curve: TransitionCurve, _ x: Double) -> Double { curveIn(curve, 1 - clamp01(x)) }

    static func audible(_ plan: MixPlan, _ layer: MixLayer) -> Bool {
        if layer.muted == true { return false }
        let anySolo = plan.layers.contains { $0.solo == true }
        return !anySolo || layer.solo == true
    }

    public static func duckWeight(_ plan: MixPlan, _ tMs: Double) -> Double {
        guard let d = plan.ducking, d.enabled else { return 0 }
        let attack = Double(d.attackMs ?? defaultAttackMs)
        let release = Double(d.releaseMs ?? defaultReleaseMs)
        var w = 0.0
        for s in plan.layers where s.role == .speech && audible(plan, s) {
            let start = Double(s.startMs)
            let end = Double(s.startMs + s.durationMs)
            let v: Double
            if tMs < start { v = 0 }
            else if tMs >= end { v = release > 0 ? 1 - (tMs - end) / release : 0 }
            else { v = attack > 0 ? min(1, (tMs - start) / attack) : 1 }
            w = max(w, clamp01(v))
        }
        return w
    }

    /// Linear amplitude gain for a layer at plan time t (excludes master gain and pan).
    public static func layerGain(_ plan: MixPlan, _ layer: MixLayer, _ tMs: Double) -> Double {
        if !audible(plan, layer) { return 0 }
        let local = tMs - Double(layer.startMs)
        let dur = Double(layer.durationMs)
        if local < 0 || local >= dur { return 0 }
        var g = dbToLinear(layer.gainDb)
        let fadeIn = Double(layer.fadeInMs), fadeOut = Double(layer.fadeOutMs)
        if fadeIn > 0 && local < fadeIn { g *= curveIn(.equalPower, local / fadeIn) }
        let remaining = dur - local
        if fadeOut > 0 && remaining < fadeOut { g *= curveIn(.equalPower, remaining / fadeOut) }
        for tr in plan.transitions ?? [] {
            let s = Double(tr.startMs), d = Double(tr.durationMs)
            if tr.fromLayerId == layer.id && tMs >= s { g *= d > 0 ? curveOut(tr.curve, (tMs - s) / d) : 0 }
            if tr.toLayerId == layer.id {
                if tMs < s { g = 0 } else { g *= d > 0 ? curveIn(tr.curve, (tMs - s) / d) : 1 }
            }
        }
        if layer.role != .speech {
            let w = duckWeight(plan, tMs)
            if w > 0 { g *= dbToLinear(-(plan.ducking?.amountDb ?? defaultDuckDb) * w) }
        }
        return g
    }

    public static func masterGain(_ plan: MixPlan) -> Double { dbToLinear(plan.masterGainDb ?? defaultMasterGainDb) }

    /// Equal-power pan law → (left, right).
    public static func panGains(_ pan: Double) -> (Double, Double) {
        let p = max(-1, min(1, pan))
        let angle = (p + 1) * .pi / 4
        return (cos(angle), sin(angle))
    }

    /// Source position (ms into the asset) at plan time t, or nil when silent.
    public static func sourcePositionMs(_ layer: MixLayer, assetDurationMs: Int, _ tMs: Double) -> Double? {
        let local = tMs - Double(layer.startMs)
        if local < 0 || local >= Double(layer.durationMs) { return nil }
        if layer.loop {
            let loopLen = Double(assetDurationMs - layer.sourceInMs)
            if loopLen <= 0 { return nil }
            return Double(layer.sourceInMs) + local.truncatingRemainder(dividingBy: loopLen)
        }
        let pos = Double(layer.sourceInMs) + local
        return pos < Double(assetDurationMs) ? pos : nil
    }
}

/// A contiguous piece of a source file the engine must schedule on a layer's player.
public struct ScheduledSegment: Equatable, Sendable {
    /// Offset from the playback start (the moment `fromMs` begins) at which this segment starts, in ms.
    public var startOffsetMs: Double
    /// Position within the source file, in ms.
    public var sourceStartMs: Double
    public var durationMs: Double
}

/// Pure scheduling: converts a layer + playhead into source segments (handles trim, loops, run-out).
public enum FusionScheduler {
    public static func segments(for layer: MixLayer, assetDurationMs: Int, fromMs: Double, maxSegments: Int = 2000) -> [ScheduledSegment] {
        let layerStart = Double(layer.startMs)
        let layerEnd = Double(layer.startMs + layer.durationMs)
        guard fromMs < layerEnd, assetDurationMs > 0 else { return [] }
        var t = max(fromMs, layerStart)
        var out: [ScheduledSegment] = []
        while t < layerEnd && out.count < maxSegments {
            guard let src = Envelope.sourcePositionMs(layer, assetDurationMs: assetDurationMs, t) else { break }
            let availableInSource = Double(assetDurationMs) - src
            let len = min(availableInSource, layerEnd - t)
            if len <= 0.5 { break }
            out.append(ScheduledSegment(startOffsetMs: t - fromMs, sourceStartMs: src, durationMs: len))
            if !layer.loop { break }
            t += len
        }
        return out
    }
}
