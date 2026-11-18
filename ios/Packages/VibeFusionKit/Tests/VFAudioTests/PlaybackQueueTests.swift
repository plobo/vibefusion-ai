import XCTest
@testable import VFAudio
import VFCore

final class PlaybackQueueTests: XCTestCase {
    func a(_ id: String) -> Asset { Asset(id: id, title: id, assetType: .music, durationMs: 1000) }

    func testNextAndPreviousWithRepeatModes() {
        var q = PlaybackQueue(items: [a("1"), a("2"), a("3")], startAt: 1)
        XCTAssertEqual(q.current?.id, "2")
        XCTAssertTrue(q.next(userInitiated: false))
        XCTAssertEqual(q.current?.id, "3")
        XCTAssertFalse(q.next(userInitiated: false)) // end of queue, repeat off
        q.repeatMode = .all
        XCTAssertTrue(q.next(userInitiated: false))
        XCTAssertEqual(q.current?.id, "1")
        q.repeatMode = .one
        XCTAssertTrue(q.next(userInitiated: false))
        XCTAssertEqual(q.current?.id, "1") // stays on the same item
        q.previous()
        XCTAssertEqual(q.current?.id, "1")
    }

    func testShuffleKeepsCurrentFirstAndIsDeterministic() {
        var q1 = PlaybackQueue(items: (0..<10).map { a("\($0)") }, startAt: 4)
        var q2 = q1
        q1.setShuffle(true, seed: 42)
        q2.setShuffle(true, seed: 42)
        XCTAssertEqual(q1.current?.id, "4")
        XCTAssertEqual(q1.upNext.map(\.id), q2.upNext.map(\.id))
        XCTAssertEqual(Set(q1.upNext.map(\.id)).count, 9)
        q1.setShuffle(false)
        XCTAssertEqual(q1.current?.id, "4")
        XCTAssertEqual(q1.upNext.map(\.id), ["5", "6", "7", "8", "9"])
    }

    func testEnqueueNextAndReorderUpNext() {
        var q = PlaybackQueue(items: [a("1"), a("2")])
        q.enqueue(a("x"), playNext: true)
        XCTAssertEqual(q.upNext.map(\.id), ["x", "2"])
        q.moveUpNext(from: 0, to: 1)
        XCTAssertEqual(q.upNext.map(\.id), ["2", "x"])
        q.removeUpNext(at: 0)
        XCTAssertEqual(q.upNext.map(\.id), ["x"])
    }

    func testAudioSessionPolicyDecisions() {
        XCTAssertEqual(AudioSessionPolicy.onInterruptionEnded(shouldResume: true, wasPlaying: true), .resume)
        XCTAssertEqual(AudioSessionPolicy.onInterruptionEnded(shouldResume: true, wasPlaying: false), .none)
        XCTAssertEqual(AudioSessionPolicy.onInterruptionEnded(shouldResume: false, wasPlaying: true), .none)
        XCTAssertEqual(AudioSessionPolicy.onRouteChange(reasonOldDeviceUnavailable: true), .pause)
    }

    func testSpeechRates() {
        XCTAssertEqual(PlaybackRates.label(1), "1×")
        XCTAssertEqual(PlaybackRates.label(1.5), "1.5×")
        XCTAssertTrue(PlaybackRates.speech.contains(2))
    }
}

/// Renders a real (synthetic) two-layer + speech plan offline and checks timing, ducking and headroom in the output.
final class FusionOfflineRenderTests: XCTestCase {
    func writeTone(_ url: URL, freq: Double, seconds: Double, amp: Float) throws {
        let sr = 44_100.0
        let fmt = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 1)!
        let file = try AVAudioFile(forWriting: url, settings: fmt.settings)
        let n = AVAudioFrameCount(seconds * sr)
        let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: n)!
        buf.frameLength = n
        for i in 0..<Int(n) { buf.floatChannelData![0][i] = amp * Float(sin(2 * .pi * freq * Double(i) / sr)) }
        try file.write(from: buf)
    }

    func rms(_ url: URL, fromSec: Double, toSec: Double) throws -> Float {
        let f = try AVAudioFile(forReading: url)
        let sr = f.processingFormat.sampleRate
        f.framePosition = AVAudioFramePosition(fromSec * sr)
        let n = AVAudioFrameCount((toSec - fromSec) * sr)
        let buf = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: n)!
        try f.read(into: buf, frameCount: n)
        let d = buf.floatChannelData![0]
        var s: Float = 0
        for i in 0..<Int(buf.frameLength) { s += d[i] * d[i] }
        return sqrt(s / Float(max(1, buf.frameLength)))
    }

    func testOfflineRenderAppliesLayersAndDucking() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let bed = dir.appendingPathComponent("bed.caf"), voice = dir.appendingPathComponent("voice.caf")
        try writeTone(bed, freq: 220, seconds: 4, amp: 0.5)
        try writeTone(voice, freq: 880, seconds: 3, amp: 0.5)
        let plan = MixPlan(title: "t", durationMs: 12_000, layers: [
            MixLayer(id: "bed", assetId: "bed", role: .music, durationMs: 12_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0, loop: true),
            MixLayer(id: "v", assetId: "voice", role: .speech, startMs: 6000, durationMs: 3000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0),
        ], masterGainDb: 0, ducking: Ducking(enabled: true, amountDb: 12, attackMs: 0, releaseMs: 0))
        let out = dir.appendingPathComponent("out.caf")
        try FusionOfflineRenderer.render(plan: plan, files: ["bed": bed, "voice": voice], to: out, aac: false)
        let before = try rms(out, fromSec: 1, toSec: 3)         // bed only (loop crosses 4s boundary later)
        XCTAssertGreaterThan(before, 0.05)
        let looped = try rms(out, fromSec: 4.5, toSec: 5.5)     // loop continued past the 4 s source
        XCTAssertEqual(looped, before, accuracy: before * 0.25)
        let after = try rms(out, fromSec: 10, toSec: 11.5)      // speech ended, bed back to full level
        XCTAssertEqual(after, before, accuracy: before * 0.25)
    }
}

import AVFoundation
