import XCTest
@testable import VFCore

/// Verifies the Swift envelope reproduces contracts/fixtures/envelope-cases.json (generated from the TypeScript reference).
final class EnvelopeFixtureTests: XCTestCase {
    struct Fixture: Decodable {
        struct Case: Decodable {
            struct Sample: Decodable {
                var tMs: Double
                var duckWeight: Double
                var gains: [String: Double]
                var sourcePositionsMs: [String: Double?]
            }
            var name: String
            var plan: MixPlan
            var assetDurationsMs: [String: Int]
            var masterGain: Double
            var pan: [String: [Double]]
            var samples: [Sample]
        }
        var tolerance: Double
        var cases: [Case]
    }

    static func repoFile(_ rel: String) -> URL {
        // Tests/VFCoreTests/<file> → repo root is five levels up from this file.
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../\(rel)").standardized
    }

    func testEnvelopeMatchesSharedFixtures() throws {
        let data = try Data(contentsOf: Self.repoFile("contracts/fixtures/envelope-cases.json"))
        let fx = try JSONDecoder().decode(Fixture.self, from: data)
        XCTAssertGreaterThanOrEqual(fx.cases.count, 3)
        var checked = 0
        for c in fx.cases {
            XCTAssertEqual(Envelope.masterGain(c.plan), c.masterGain, accuracy: fx.tolerance, c.name)
            for layer in c.plan.layers {
                let (l, r) = Envelope.panGains(layer.pan)
                XCTAssertEqual(l, c.pan[layer.id]![0], accuracy: fx.tolerance)
                XCTAssertEqual(r, c.pan[layer.id]![1], accuracy: fx.tolerance)
            }
            for s in c.samples {
                XCTAssertEqual(Envelope.duckWeight(c.plan, s.tMs), s.duckWeight, accuracy: fx.tolerance, "\(c.name) duck @\(s.tMs)")
                for layer in c.plan.layers {
                    XCTAssertEqual(Envelope.layerGain(c.plan, layer, s.tMs), s.gains[layer.id]!, accuracy: fx.tolerance, "\(c.name) \(layer.id) @\(s.tMs)")
                    let expected = s.sourcePositionsMs[layer.id] ?? nil
                    let actual = Envelope.sourcePositionMs(layer, assetDurationMs: c.assetDurationsMs[layer.assetId] ?? 0, s.tMs)
                    if let expected { XCTAssertEqual(actual ?? -1, expected, accuracy: 0.001) } else { XCTAssertNil(actual) }
                    checked += 1
                }
            }
        }
        XCTAssertGreaterThan(checked, 50)
    }

    func testValidPlanFixtureDecodes() throws {
        let plan = try JSONDecoder().decode(MixPlan.self, from: Data(contentsOf: Self.repoFile("contracts/fixtures/mix-plan-valid.json")))
        XCTAssertEqual(plan.layers.count, 3)
        XCTAssertTrue(MixPlanLocalCheck.issues(plan).isEmpty)
        // Round trip keeps the wire format.
        let again = try JSONDecoder().decode(MixPlan.self, from: JSONEncoder().encode(plan))
        XCTAssertEqual(again, plan)
    }

    func testFadesAreMonotonic() {
        let l = MixLayer(id: "a", assetId: "x", role: .music, durationMs: 60_000, gainDb: 0, fadeInMs: 4000, fadeOutMs: 4000)
        let p = MixPlan(title: "t", durationMs: 60_000, layers: [l])
        var prev = -1.0
        for t in stride(from: 0.0, through: 4000, by: 50) { let g = Envelope.layerGain(p, l, t); XCTAssertGreaterThanOrEqual(g, prev); prev = g }
        prev = 2
        for t in stride(from: 56_000.0, to: 60_000, by: 50) { let g = Envelope.layerGain(p, l, t); XCTAssertLessThanOrEqual(g, prev); prev = g }
    }
}

final class SchedulerTests: XCTestCase {
    func testLoopingLayerProducesContiguousSegments() {
        let l = MixLayer(id: "a", assetId: "x", role: .music, startMs: 10_000, sourceInMs: 2000, durationMs: 50_000, loop: true)
        let segs = FusionScheduler.segments(for: l, assetDurationMs: 16_000, fromMs: 0)
        XCTAssertEqual(segs.first, ScheduledSegment(startOffsetMs: 10_000, sourceStartMs: 2000, durationMs: 14_000))
        XCTAssertEqual(segs.reduce(0) { $0 + $1.durationMs }, 50_000, accuracy: 0.01)
        for (a, b) in zip(segs, segs.dropFirst()) { XCTAssertEqual(a.startOffsetMs + a.durationMs, b.startOffsetMs, accuracy: 0.01) }
        XCTAssertTrue(segs.dropFirst().allSatisfy { $0.sourceStartMs == 2000 })
    }

    func testSeekIntoLoopStartsMidSource() {
        let l = MixLayer(id: "a", assetId: "x", role: .music, durationMs: 100_000, loop: true)
        let segs = FusionScheduler.segments(for: l, assetDurationMs: 30_000, fromMs: 45_000)
        XCTAssertEqual(segs.first?.startOffsetMs, 0)
        XCTAssertEqual(segs.first?.sourceStartMs, 15_000)
        XCTAssertEqual(segs.first?.durationMs, 15_000)
    }

    func testNonLoopingRunsOutAndPastEndIsEmpty() {
        let l = MixLayer(id: "a", assetId: "x", role: .speech, startMs: 0, durationMs: 60_000, loop: false)
        XCTAssertEqual(FusionScheduler.segments(for: l, assetDurationMs: 40_000, fromMs: 0), [ScheduledSegment(startOffsetMs: 0, sourceStartMs: 0, durationMs: 40_000)])
        XCTAssertTrue(FusionScheduler.segments(for: l, assetDurationMs: 40_000, fromMs: 45_000).isEmpty)
        XCTAssertTrue(FusionScheduler.segments(for: l, assetDurationMs: 40_000, fromMs: 70_000).isEmpty)
    }
}
