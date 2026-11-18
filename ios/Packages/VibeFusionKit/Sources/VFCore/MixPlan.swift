import Foundation

/// Platform-neutral mix plan (contracts/schemas/mix-plan.schema.json, version 1).
public struct MixPlan: Codable, Hashable, Sendable {
    public var version: Int = 1
    public var title: String
    public var description: String?
    public var durationMs: Int
    public var tempoBpm: Double?
    public var snapToBeat: Bool?
    public var masterGainDb: Double?
    public var ducking: Ducking?
    public var layers: [MixLayer]
    public var transitions: [MixTransition]?
    public var warnings: [String]?

    public init(title: String, durationMs: Int, layers: [MixLayer], tempoBpm: Double? = nil, masterGainDb: Double? = -3,
                ducking: Ducking? = nil, transitions: [MixTransition]? = [], description: String? = nil) {
        self.title = title; self.durationMs = durationMs; self.layers = layers; self.tempoBpm = tempoBpm
        self.masterGainDb = masterGainDb; self.ducking = ducking; self.transitions = transitions; self.description = description
    }
}

public enum LayerRole: String, Codable, CaseIterable, Sendable {
    case music, speech, ambience, percussion, effect
}

public struct MixLayer: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var assetId: String
    public var role: LayerRole
    public var startMs: Int
    public var sourceInMs: Int
    public var durationMs: Int
    public var gainDb: Double
    public var fadeInMs: Int
    public var fadeOutMs: Int
    public var loop: Bool
    public var pan: Double
    public var muted: Bool?
    public var solo: Bool?

    public init(id: String, assetId: String, role: LayerRole, startMs: Int = 0, sourceInMs: Int = 0, durationMs: Int,
                gainDb: Double = -10, fadeInMs: Int = 2000, fadeOutMs: Int = 3000, loop: Bool = false, pan: Double = 0,
                muted: Bool? = nil, solo: Bool? = nil) {
        self.id = id; self.assetId = assetId; self.role = role; self.startMs = startMs; self.sourceInMs = sourceInMs
        self.durationMs = durationMs; self.gainDb = gainDb; self.fadeInMs = fadeInMs; self.fadeOutMs = fadeOutMs
        self.loop = loop; self.pan = pan; self.muted = muted; self.solo = solo
    }

    public var endMs: Int { startMs + durationMs }
}

public enum TransitionCurve: String, Codable, CaseIterable, Sendable { case linear, equalPower = "equal_power", exponential }

public struct MixTransition: Codable, Hashable, Sendable {
    public var fromLayerId: String
    public var toLayerId: String
    public var startMs: Int
    public var durationMs: Int
    public var curve: TransitionCurve
    public init(fromLayerId: String, toLayerId: String, startMs: Int, durationMs: Int, curve: TransitionCurve) {
        self.fromLayerId = fromLayerId; self.toLayerId = toLayerId; self.startMs = startMs; self.durationMs = durationMs; self.curve = curve
    }
}

public struct Ducking: Codable, Hashable, Sendable {
    public var enabled: Bool
    public var amountDb: Double?
    public var attackMs: Int?
    public var releaseMs: Int?
    public init(enabled: Bool, amountDb: Double? = 9, attackMs: Int? = 300, releaseMs: Int? = 800) {
        self.enabled = enabled; self.amountDb = amountDb; self.attackMs = attackMs; self.releaseMs = releaseMs
    }
}

/// Local, deterministic checks mirroring the server's semantic rules, used for instant editor feedback.
/// The server remains authoritative for schema and rights validation.
public enum MixPlanLocalCheck {
    public static func issues(_ plan: MixPlan, maxLayers: Int = 6) -> [String] {
        var out: [String] = []
        if plan.layers.isEmpty { out.append("Add at least one layer.") }
        if plan.layers.count > maxLayers { out.append("A session can have at most \(maxLayers) layers.") }
        if Set(plan.layers.map(\.id)).count != plan.layers.count { out.append("Layer ids must be unique.") }
        for l in plan.layers {
            if l.startMs >= plan.durationMs { out.append("Layer \(l.id) starts after the session ends.") }
            if l.gainDb < -60 || l.gainDb > 6 { out.append("Layer \(l.id) gain must be between -60 and +6 dB.") }
            if l.pan < -1 || l.pan > 1 { out.append("Layer \(l.id) pan is out of range.") }
            if l.durationMs < 1000 { out.append("Layer \(l.id) must last at least one second.") }
        }
        return out
    }
}
