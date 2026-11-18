import Foundation

/// Privacy-filtered product event (names from IMPLEMENTATION_PLAN §13). Never include prompts, transcripts, emails or URLs.
public struct AnalyticsEvent: Codable, Equatable, Sendable {
    public var name: String
    public var occurredAt: String
    public var properties: [String: AnalyticsValue]
    public init(name: String, properties: [String: AnalyticsValue] = [:], at date: Date = Date()) {
        self.name = name
        self.properties = properties
        self.occurredAt = ISO8601DateFormatter().string(from: date)
    }
}

public enum AnalyticsValue: Codable, Equatable, Sendable, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral {
    case string(String), int(Int), bool(Bool)
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .int(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .string(let s): try c.encode(s); case .int(let i): try c.encode(i); case .bool(let b): try c.encode(b) }
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let i = try? c.decode(Int.self) { self = .int(i) } else if let b = try? c.decode(Bool.self) { self = .bool(b) } else { self = .string(try c.decode(String.self)) }
    }
}

/// Batches events in memory and flushes them; drops everything when the user opts out.
public actor AnalyticsClient {
    private var buffer: [AnalyticsEvent] = []
    private let api: VibeFusionAPIProtocol
    public var enabled = true
    private let maxBatch = 20

    public init(api: VibeFusionAPIProtocol) { self.api = api }

    public func setEnabled(_ on: Bool) { enabled = on; if !on { buffer.removeAll() } }

    public func track(_ name: String, _ props: [String: AnalyticsValue] = [:]) async {
        guard enabled else { return }
        buffer.append(AnalyticsEvent(name: name, properties: props))
        if buffer.count >= maxBatch { await flush() }
    }

    public func flush() async {
        guard enabled, !buffer.isEmpty else { return }
        let batch = buffer
        buffer.removeAll()
        do { try await api.sendEvents(batch) } catch {
            // Keep a bounded backlog for the next flush; analytics must never affect playback.
            buffer = Array((batch + buffer).suffix(100))
        }
    }

    public var pendingCount: Int { buffer.count }
}
