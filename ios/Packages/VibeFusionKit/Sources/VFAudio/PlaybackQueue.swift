import Foundation
import VFCore

public enum RepeatMode: String, CaseIterable, Sendable { case off, all, one }

public enum PlaybackPhase: Equatable, Sendable {
    case idle, loading, playing, paused, buffering, ended
    case failed(String)
    public var isActive: Bool { self == .playing || self == .buffering || self == .loading }
}

/// Pure queue model (shuffle/repeat/next/previous). Deterministic given a seed so it is unit-testable.
public struct PlaybackQueue: Equatable, Sendable {
    public private(set) var items: [Asset] = []
    public private(set) var order: [Int] = []
    public private(set) var cursor: Int = 0
    public var repeatMode: RepeatMode = .off
    public private(set) var shuffled = false

    public init() {}

    public init(items: [Asset], startAt: Int = 0) {
        self.items = items
        order = Array(items.indices)
        cursor = min(max(0, startAt), max(0, items.count - 1))
    }

    public var current: Asset? { order.indices.contains(cursor) ? items[order[cursor]] : nil }
    public var upNext: [Asset] { order.indices.contains(cursor + 1) ? order[(cursor + 1)...].map { items[$0] } : [] }
    public var isEmpty: Bool { items.isEmpty }

    /// Advance after a track ends or the user taps Next. Returns false when playback should stop.
    public mutating func next(userInitiated: Bool) -> Bool {
        guard !items.isEmpty else { return false }
        if repeatMode == .one && !userInitiated { return true }
        if cursor + 1 < order.count { cursor += 1; return true }
        if repeatMode == .all || (repeatMode == .one && userInitiated) { cursor = 0; return true }
        return false
    }

    public mutating func previous() {
        if cursor > 0 { cursor -= 1 } else if repeatMode == .all { cursor = max(0, order.count - 1) }
    }

    public mutating func setShuffle(_ on: Bool, seed: UInt64 = UInt64(Date().timeIntervalSince1970)) {
        guard on != shuffled, !items.isEmpty else { shuffled = on; return }
        let currentIndex = order.indices.contains(cursor) ? order[cursor] : 0
        if on {
            var rng = SeededGenerator(seed: seed)
            var rest = Array(items.indices).filter { $0 != currentIndex }
            rest.shuffle(using: &rng)
            order = [currentIndex] + rest
            cursor = 0
        } else {
            order = Array(items.indices)
            cursor = currentIndex
        }
        shuffled = on
    }

    public mutating func enqueue(_ asset: Asset, playNext: Bool) {
        items.append(asset)
        let idx = items.count - 1
        if playNext && !order.isEmpty { order.insert(idx, at: cursor + 1) } else { order.append(idx) }
    }

    public mutating func jump(toUpNextIndex i: Int) {
        let target = cursor + 1 + i
        if order.indices.contains(target) { cursor = target }
    }

    public mutating func removeUpNext(at i: Int) {
        let target = cursor + 1 + i
        if order.indices.contains(target) { order.remove(at: target) }
    }

    public mutating func moveUpNext(from: Int, to: Int) {
        let a = cursor + 1 + from, b = cursor + 1 + to
        guard order.indices.contains(a), order.indices.contains(b) else { return }
        let v = order.remove(at: a)
        order.insert(v, at: b)
    }
}

public struct SeededGenerator: RandomNumberGenerator, Sendable {
    private var state: UInt64
    public init(seed: UInt64) { state = seed == 0 ? 0x9E3779B97F4A7C15 : seed }
    public mutating func next() -> UInt64 {
        state ^= state << 13; state ^= state >> 7; state ^= state << 17
        return state
    }
}

/// Sleep timer semantics shared with Android.
public enum SleepTimerOption: Equatable, Hashable, Sendable {
    case off, minutes(Int), endOfItem
    public static let presets: [SleepTimerOption] = [.off, .minutes(5), .minutes(15), .minutes(30), .minutes(60), .endOfItem]
    public var label: String {
        switch self { case .off: return "Off"; case .minutes(let m): return "\(m) min"; case .endOfItem: return "End of episode" }
    }
}

public enum PlaybackRates {
    public static let speech: [Float] = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
    public static func label(_ r: Float) -> String { r == 1 ? "1×" : String(format: "%g×", r) }
}
