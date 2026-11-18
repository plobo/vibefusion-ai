import AVFoundation
import Foundation
import Observation
import VFCore

/// Downloads authorized layer media into a private, ephemeral cache so AVAudioFile can stream it from disk.
public final class FusionMediaLoader: @unchecked Sendable {
    private let dir: URL
    private let session: URLSession
    public init(session: URLSession = .shared) {
        self.session = session
        dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("fusion-buffers", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    public func localFile(assetId: String, remote: URL, progress: @Sendable (Double) -> Void = { _ in }) async throws -> URL {
        let ext = remote.pathExtension.isEmpty ? "mp3" : remote.pathExtension
        let dest = dir.appendingPathComponent("\(assetId).\(ext)")
        if FileManager.default.fileExists(atPath: dest.path) { return dest }
        if remote.isFileURL { return remote }
        let (tmp, resp) = try await session.download(from: remote)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError(code: "MEDIA_UNAVAILABLE", message: "A layer's audio couldn't be loaded.", status: (resp as? HTTPURLResponse)?.statusCode ?? 0, retryable: true)
        }
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tmp, to: dest)
        progress(1)
        return dest
    }

    public func purge() { try? FileManager.default.removeItem(at: dir); try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
}

/// Synchronized multi-layer engine (AVAudioEngine + one AVAudioPlayerNode per layer).
/// Timing is sample-accurate (all nodes start at one host time); gain automation runs at control rate (50 Hz)
/// from the deterministic Envelope — never from LLM timing.
@MainActor
@Observable
public final class FusionPlaybackEngine: RemoteControllable {
    public enum State: Equatable { case idle, preparing(Double), ready, playing, paused, interrupted, ended, failed(String) }

    public private(set) var state: State = .idle
    public private(set) var positionMs: Double = 0
    public private(set) var plan: MixPlan?
    public private(set) var levels: [String: Double] = [:]
    public private(set) var duckActive = false
    public var title: String { plan?.title ?? "Fusion session" }
    public var durationMs: Int { plan?.durationMs ?? 0 }
    public var isPlaying: Bool { state == .playing }

    @ObservationIgnored private var engine = AVAudioEngine()
    @ObservationIgnored private var players: [String: AVAudioPlayerNode] = [:]
    @ObservationIgnored private var files: [String: AVAudioFile] = [:]
    @ObservationIgnored private var limiter: AVAudioUnitEffect?
    @ObservationIgnored private var startHostTime: UInt64 = 0
    @ObservationIgnored private var playheadAtStart: Double = 0
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private let loader: FusionMediaLoader
    @ObservationIgnored private var wasPlayingBeforeInterruption = false
    @ObservationIgnored public var onBecameActive: (() -> Void)?
    @ObservationIgnored public var onUnderrun: (() -> Void)?

    public init(loader: FusionMediaLoader = FusionMediaLoader()) { self.loader = loader }

    /// Downloads authorized media and builds the graph. `media` maps assetId → signed URL (from the backend only).
    public func prepare(plan: MixPlan, media: [String: URL]) async throws {
        release()
        state = .preparing(0)
        self.plan = plan
        let assetIds = Array(Set(plan.layers.map(\.assetId)))
        var done = 0.0
        for id in assetIds {
            guard let remote = media[id] else { continue }
            let local = try await loader.localFile(assetId: id, remote: remote)
            files[id] = try AVAudioFile(forReading: local)
            done += 1
            state = .preparing(done / Double(max(1, assetIds.count)))
        }
        try buildGraph()
        observe()
        state = .ready
        positionMs = 0
        applyAutomation(at: 0)
    }

    public func assetDurationMs(_ assetId: String) -> Int {
        guard let f = files[assetId] else { return 0 }
        return Int(Double(f.length) / f.processingFormat.sampleRate * 1000)
    }

    private func buildGraph() throws {
        guard let plan else { return }
        engine = AVAudioEngine()
        players = [:]
        let limiterDesc = AudioComponentDescription(componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
                                                    componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
        let lim = AVAudioUnitEffect(audioComponentDescription: limiterDesc)
        engine.attach(lim)
        limiter = lim
        for layer in plan.layers {
            guard let file = files[layer.assetId] else { continue }
            let node = AVAudioPlayerNode()
            engine.attach(node)
            engine.connect(node, to: engine.mainMixerNode, format: file.processingFormat)
            node.pan = Float(layer.pan)
            node.volume = 0
            players[layer.id] = node
        }
        engine.disconnectNodeOutput(engine.mainMixerNode)
        engine.connect(engine.mainMixerNode, to: lim, format: nil)
        engine.connect(lim, to: engine.outputNode, format: nil)
        engine.mainMixerNode.outputVolume = Float(Envelope.masterGain(plan))
        engine.prepare()
    }

    // MARK: Transport

    public func play() {
        guard plan != nil, state != .idle else { return }
        if state == .ended { positionMs = 0 }
        onBecameActive?()
        AudioSessionController.shared.activate()
        RemoteCommandRouter.shared.target = self
        start(from: positionMs)
    }

    public func pause() {
        guard state == .playing else { return }
        positionMs = currentPlayhead()
        stopNodes()
        engine.pause()
        stopTimer()
        state = .paused
        updateNowPlaying()
    }

    public func toggle() { isPlaying ? pause() : play() }

    public func seek(toMs ms: Double) {
        let target = max(0, min(ms, Double(durationMs) - 100))
        let wasPlaying = isPlaying
        stopNodes()
        positionMs = target
        applyAutomation(at: target)
        if wasPlaying { start(from: target) } else { updateNowPlaying() }
    }

    public func stop() {
        stopNodes()
        engine.stop()
        stopTimer()
        positionMs = 0
        if plan != nil { state = .ready }
        RemoteCommandRouter.shared.clear()
    }

    /// Live editing: gain/mute/solo/fade changes apply on the next automation tick; timing changes reschedule.
    public func update(plan newPlan: MixPlan) {
        guard let old = plan else { return }
        let timingChanged = old.layers.map { [$0.id, "\($0.startMs)", "\($0.sourceInMs)", "\($0.durationMs)", "\($0.loop)", $0.assetId] } !=
            newPlan.layers.map { [$0.id, "\($0.startMs)", "\($0.sourceInMs)", "\($0.durationMs)", "\($0.loop)", $0.assetId] }
        plan = newPlan
        for l in newPlan.layers { players[l.id]?.pan = Float(l.pan) }
        engine.mainMixerNode.outputVolume = Float(Envelope.masterGain(newPlan))
        if timingChanged {
            if Set(newPlan.layers.map(\.id)) != Set(old.layers.map(\.id)) { return } // structure changes need prepare()
            seek(toMs: currentPlayhead())
        } else {
            applyAutomation(at: currentPlayhead())
        }
    }

    /// Tears down nodes, observers and cached buffers deterministically.
    public func release() {
        stopTimer()
        stopNodes()
        engine.stop()
        for (_, p) in players { engine.detach(p) }
        if let l = limiter { engine.detach(l) }
        players = [:]
        files = [:]
        limiter = nil
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers = []
        state = .idle
        plan = nil
        levels = [:]
    }

    public func purgeCache() { loader.purge() }

    private func start(from ms: Double) {
        guard let plan else { return }
        do {
            if !engine.isRunning { try engine.start() }
        } catch {
            state = .failed("Audio output is unavailable.")
            return
        }
        stopNodes()
        for layer in plan.layers {
            guard let node = players[layer.id], let file = files[layer.assetId] else { continue }
            let sr = file.processingFormat.sampleRate
            for seg in FusionScheduler.segments(for: layer, assetDurationMs: assetDurationMs(layer.assetId), fromMs: ms) {
                let startFrame = AVAudioFramePosition(seg.sourceStartMs / 1000 * sr)
                guard startFrame < file.length else { continue }
                let frames = AVAudioFrameCount(min(Double(file.length - startFrame), seg.durationMs / 1000 * sr))
                guard frames > 0 else { continue }
                let when = AVAudioTime(sampleTime: AVAudioFramePosition(seg.startOffsetMs / 1000 * sr), atRate: sr)
                node.scheduleSegment(file, startingFrame: startFrame, frameCount: frames, at: when, completionHandler: nil)
            }
        }
        applyAutomation(at: ms)
        let lead = AVAudioTime.hostTime(forSeconds: 0.1)
        startHostTime = mach_absolute_time() + lead
        playheadAtStart = ms
        let at = AVAudioTime(hostTime: startHostTime)
        for (_, node) in players { node.play(at: at) }
        state = .playing
        startTimer()
        updateNowPlaying()
    }

    private func stopNodes() { for (_, p) in players { p.stop() } }

    public func currentPlayhead() -> Double {
        guard state == .playing else { return positionMs }
        let now = mach_absolute_time()
        guard now > startHostTime else { return playheadAtStart }
        return playheadAtStart + AVAudioTime.seconds(forHostTime: now - startHostTime) * 1000
    }

    private func startTimer() {
        stopTimer()
        let t = Timer(timeInterval: 0.02, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func stopTimer() { timer?.invalidate(); timer = nil }

    private var tickCount = 0
    private func tick() {
        guard state == .playing else { return }
        let t = currentPlayhead()
        if t >= Double(durationMs) {
            stopNodes(); engine.pause(); stopTimer()
            positionMs = Double(durationMs)
            state = .ended
            updateNowPlaying()
            return
        }
        positionMs = t
        applyAutomation(at: t)
        tickCount += 1
        if tickCount % 100 == 0 { updateNowPlaying() }
    }

    private func applyAutomation(at t: Double) {
        guard let plan else { return }
        var lv: [String: Double] = [:]
        for layer in plan.layers {
            let g = Envelope.layerGain(plan, layer, t)
            players[layer.id]?.volume = Float(g)
            lv[layer.id] = g
        }
        levels = lv
        duckActive = Envelope.duckWeight(plan, t) > 0.01
    }

    // MARK: Interruptions, route changes, engine configuration changes

    private func observe() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.recoverFromConfigurationChange() }
        })
    }

    /// Route/sample-rate changes stop the engine; restart from the same playhead without leaking nodes.
    private func recoverFromConfigurationChange() {
        let wasPlaying = isPlaying
        let p = currentPlayhead()
        stopNodes()
        stopTimer()
        positionMs = p
        if wasPlaying { start(from: p) } else if state != .idle { state = .paused }
    }

    public func handleInterruptionBegan() {
        wasPlayingBeforeInterruption = isPlaying
        if isPlaying { pause(); state = .interrupted }
    }

    public func handleInterruptionEnded(shouldResume: Bool) {
        if AudioSessionPolicy.onInterruptionEnded(shouldResume: shouldResume, wasPlaying: wasPlayingBeforeInterruption) == .resume { play() }
        else if state == .interrupted { state = .paused }
    }

    public func handleRouteLost() { if isPlaying { pause() } }

    /// Media services reset invalidates every audio object: rebuild the graph from retained files.
    public func handleMediaServicesReset() {
        let p = currentPlayhead()
        let wasPlaying = isPlaying
        stopTimer()
        for (_, n) in players { engine.detach(n) }
        try? buildGraph()
        positionMs = p
        if wasPlaying { start(from: p) } else { state = .paused }
    }

    private func updateNowPlaying() {
        RemoteCommandRouter.shared.update(title: title, artist: "VibeFusion AI Studio", durationMs: durationMs, positionMs: Int(positionMs), rate: isPlaying ? 1 : 0)
    }

    // MARK: RemoteControllable
    public func remotePlay() { play() }
    public func remotePause() { pause() }
    public func remoteToggle() { toggle() }
    public func remoteNext() { seek(toMs: positionMs + 30_000) }
    public func remotePrevious() { seek(toMs: positionMs - 15_000) }
    public func remoteSeek(toMs: Int) { seek(toMs: Double(toMs)) }
    public func remoteSkip(bySeconds: Double) { seek(toMs: positionMs + bySeconds * 1000) }
    public var supportsSkipInterval: Bool { true }
}

/// Offline render (Phase 6) using AVAudioEngine manual rendering; output stays in the app's Documents/Exports.
public enum FusionOfflineRenderer {
    public static func render(plan: MixPlan, files: [String: URL], to output: URL, attribution: String? = nil, aac: Bool = true,
                              progress: @escaping @Sendable (Double) -> Void = { _ in }) throws {
        let engine = AVAudioEngine()
        let sr = 44_100.0
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2) else { return }
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
        var players: [String: AVAudioPlayerNode] = [:]
        var opened: [String: AVAudioFile] = [:]
        for (id, url) in files { opened[id] = try AVAudioFile(forReading: url) }
        for layer in plan.layers {
            guard let f = opened[layer.assetId] else { continue }
            let n = AVAudioPlayerNode()
            engine.attach(n)
            engine.connect(n, to: engine.mainMixerNode, format: f.processingFormat)
            n.pan = Float(layer.pan)
            players[layer.id] = n
        }
        engine.mainMixerNode.outputVolume = Float(Envelope.masterGain(plan))
        try engine.start()
        for layer in plan.layers {
            guard let n = players[layer.id], let f = opened[layer.assetId] else { continue }
            let fsr = f.processingFormat.sampleRate
            let dur = Int(Double(f.length) / fsr * 1000)
            for seg in FusionScheduler.segments(for: layer, assetDurationMs: dur, fromMs: 0) {
                let start = AVAudioFramePosition(seg.sourceStartMs / 1000 * fsr)
                let frames = AVAudioFrameCount(min(Double(f.length - start), seg.durationMs / 1000 * fsr))
                guard frames > 0 else { continue }
                n.scheduleSegment(f, startingFrame: start, frameCount: frames, at: AVAudioTime(sampleTime: AVAudioFramePosition(seg.startOffsetMs / 1000 * fsr), atRate: fsr))
            }
            n.play()
        }
        let settings: [String: Any] = aac
            ? [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: sr, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192_000]
            : format.settings
        try? FileManager.default.removeItem(at: output)
        let out = try AVAudioFile(forWriting: output, settings: settings)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: engine.manualRenderingMaximumFrameCount) else { return }
        let total = AVAudioFramePosition(Double(plan.durationMs) / 1000 * sr)
        while engine.manualRenderingSampleTime < total {
            let t = Double(engine.manualRenderingSampleTime) / sr * 1000
            for layer in plan.layers { players[layer.id]?.volume = Float(Envelope.layerGain(plan, layer, t)) }
            let frames = AVAudioFrameCount(min(AVAudioFramePosition(buffer.frameCapacity), total - engine.manualRenderingSampleTime))
            let status = try engine.renderOffline(frames, to: buffer)
            if status == .success { try out.write(from: buffer) } else if status == .error { break }
            progress(Double(engine.manualRenderingSampleTime) / Double(total))
        }
        engine.stop()
        _ = attribution // Attribution is shown with the export and stored alongside it by the app.
    }
}
