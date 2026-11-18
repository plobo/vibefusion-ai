import AVFoundation
import Foundation
import Observation
import VFCore

/// Resolved, playable media for one asset.
public struct ResolvedMedia: Sendable {
    public var url: URL
    public var resumePositionMs: Int
    public var isLocal: Bool
    public init(url: URL, resumePositionMs: Int, isLocal: Bool) { self.url = url; self.resumePositionMs = resumePositionMs; self.isLocal = isLocal }
}

/// Seam between the player and the app: authorization, persistence and analytics.
@MainActor
public protocol PlaybackBackend: AnyObject {
    func resolve(_ asset: Asset, forceRefresh: Bool) async throws -> ResolvedMedia
    func saveProgress(_ asset: Asset, positionMs: Int) async
    func track(_ event: String, _ props: [String: AnalyticsValue]) async
    func artwork(for asset: Asset) async -> UIImageLike?
}

/// Standard streaming (AVPlayer): queue, background audio, lock-screen controls, resume, URL refresh, sleep timer.
@MainActor
@Observable
public final class StandardPlayer: RemoteControllable {
    public private(set) var queue = PlaybackQueue()
    public private(set) var phase: PlaybackPhase = .idle
    public private(set) var positionMs: Int = 0
    public private(set) var durationMs: Int = 0
    public private(set) var rate: Float = 1
    public private(set) var sleepTimer: SleepTimerOption = .off
    public private(set) var sleepRemainingSec: Int?
    public var current: Asset? { queue.current }
    public var isPlaying: Bool { phase == .playing || phase == .buffering }

    @ObservationIgnored private let player = AVPlayer()
    @ObservationIgnored private weak var backend: PlaybackBackend?
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var itemObservers: [NSKeyValueObservation] = []
    @ObservationIgnored private var endObserver: NSObjectProtocol?
    @ObservationIgnored private var failObserver: NSObjectProtocol?
    @ObservationIgnored private var lastSavedMs = 0
    @ObservationIgnored private var refreshAttempts = 0
    @ObservationIgnored private var wasPlayingBeforeInterruption = false
    @ObservationIgnored private var sleepTask: Task<Void, Never>?
    @ObservationIgnored private var playRequestedAt: Date?
    @ObservationIgnored public var onBecameActive: (() -> Void)?

    public init(backend: PlaybackBackend) {
        self.backend = backend
        player.automaticallyWaitsToMinimizeStalling = true
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 2), queue: .main) { [weak self] t in
            MainActor.assumeIsolated { self?.tick(t) }
        }
    }

    // MARK: Public API

    public func play(_ items: [Asset], startAt index: Int = 0) {
        let playable = items.filter { $0.capabilities.stream && $0.isActive }
        guard !playable.isEmpty else { return }
        let start = playable.firstIndex(where: { $0.id == items[safe: index]?.id }) ?? 0
        queue = PlaybackQueue(items: playable, startAt: start)
        Task { await loadCurrent(autoplay: true) }
    }

    public func enqueue(_ asset: Asset, next: Bool) {
        if queue.isEmpty { play([asset]); return }
        queue.enqueue(asset, playNext: next)
    }

    public func toggle() { isPlaying ? pause() : resume() }

    public func resume() {
        guard current != nil else { return }
        onBecameActive?()
        AudioSessionController.shared.activate()
        RemoteCommandRouter.shared.target = self
        player.playImmediately(atRate: rate)
        phase = .playing
        updateNowPlaying()
    }

    public func pause() {
        player.pause()
        if phase != .idle { phase = .paused }
        persistProgress(force: true)
        updateNowPlaying()
    }

    public func stop() {
        persistProgress(force: true)
        player.pause()
        player.replaceCurrentItem(with: nil)
        phase = .idle
        queue = PlaybackQueue()
        RemoteCommandRouter.shared.clear()
    }

    public func seek(toMs ms: Int) {
        let clamped = max(0, min(ms, max(0, durationMs - 500)))
        positionMs = clamped
        player.seek(to: CMTime(value: CMTimeValue(clamped), timescale: 1000), toleranceBefore: .zero, toleranceAfter: CMTime(value: 1, timescale: 4))
        persistProgress(force: true)
        updateNowPlaying()
    }

    public func skip(bySeconds s: Double) { seek(toMs: positionMs + Int(s * 1000)) }

    public func next() {
        persistProgress(force: true)
        if queue.next(userInitiated: true) { Task { await loadCurrent(autoplay: true) } } else { pause() }
    }

    public func previous() {
        if positionMs > 3000 { seek(toMs: 0); return }
        persistProgress(force: true)
        queue.previous()
        Task { await loadCurrent(autoplay: true) }
    }

    public func setRate(_ r: Float) {
        rate = r
        if isPlaying { player.rate = r }
        updateNowPlaying()
    }

    public func setShuffle(_ on: Bool) { queue.setShuffle(on) }
    public func cycleRepeat() {
        let all = RepeatMode.allCases
        queue.repeatMode = all[(all.firstIndex(of: queue.repeatMode)! + 1) % all.count]
    }
    public func jump(toUpNext i: Int) { queue.jump(toUpNextIndex: i); Task { await loadCurrent(autoplay: true) } }
    public func removeUpNext(at i: Int) { queue.removeUpNext(at: i) }
    public func moveUpNext(from: Int, to: Int) { queue.moveUpNext(from: from, to: to) }

    public func setSleepTimer(_ option: SleepTimerOption) {
        sleepTimer = option
        sleepTask?.cancel()
        sleepRemainingSec = nil
        guard case .minutes(let m) = option else { return }
        sleepRemainingSec = m * 60
        sleepTask = Task { [weak self] in
            while let self, let rem = self.sleepRemainingSec, rem > 0, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                self.sleepRemainingSec = rem - 1
            }
            guard let self, !Task.isCancelled else { return }
            self.pause()
            self.sleepTimer = .off
            self.sleepRemainingSec = nil
        }
    }

    // MARK: Interruptions (wired by the app via AudioSessionController)

    public func handleInterruptionBegan() { wasPlayingBeforeInterruption = isPlaying; if isPlaying { pause() } }
    public func handleInterruptionEnded(shouldResume: Bool) {
        if AudioSessionPolicy.onInterruptionEnded(shouldResume: shouldResume, wasPlaying: wasPlayingBeforeInterruption) == .resume { resume() }
    }
    public func handleRouteLost() { if isPlaying { pause() } }

    // MARK: Loading

    private func loadCurrent(autoplay: Bool, forceRefresh: Bool = false, resumeAtMs: Int? = nil) async {
        guard let asset = queue.current, let backend else { return }
        phase = .loading
        playRequestedAt = Date()
        durationMs = asset.durationMs
        Task { await backend.track("asset_play_requested", ["assetId": .string(asset.id), "assetType": .string(asset.assetType.rawValue)]) }
        do {
            let media = try await backend.resolve(asset, forceRefresh: forceRefresh)
            guard queue.current?.id == asset.id else { return } // user skipped meanwhile
            let item = AVPlayerItem(url: media.url)
            item.preferredForwardBufferDuration = 30
            observe(item)
            player.replaceCurrentItem(with: item)
            let start = resumeAtMs ?? media.resumePositionMs
            if start > 0 { await player.seek(to: CMTime(value: CMTimeValue(start), timescale: 1000)); positionMs = start } else { positionMs = 0 }
            lastSavedMs = positionMs
            rate = asset.assetType.isSpoken ? rate : 1
            if autoplay { resume() } else { phase = .paused }
        } catch let e as APIError {
            phase = .failed(e.message)
            Task { await backend.track("playback_failed", ["assetId": .string(asset.id), "errorCode": .string(e.code)]) }
        } catch {
            phase = .failed("Couldn't start playback.")
        }
    }

    private func observe(_ item: AVPlayerItem) {
        itemObservers = [
            item.observe(\.status, options: [.new]) { [weak self] item, _ in
                Task { @MainActor in self?.itemStatusChanged(item) }
            },
            item.observe(\.isPlaybackBufferEmpty, options: [.new]) { [weak self] item, _ in
                Task { @MainActor in if item.isPlaybackBufferEmpty, self?.phase == .playing { self?.phase = .buffering } }
            },
            item.observe(\.isPlaybackLikelyToKeepUp, options: [.new]) { [weak self] item, _ in
                Task { @MainActor in if item.isPlaybackLikelyToKeepUp, self?.phase == .buffering { self?.phase = .playing } }
            },
        ]
        if let o = endObserver { NotificationCenter.default.removeObserver(o) }
        if let o = failObserver { NotificationCenter.default.removeObserver(o) }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.itemEnded() }
        }
        failObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.recoverFromFailure() }
        }
    }

    private func itemStatusChanged(_ item: AVPlayerItem) {
        switch item.status {
        case .readyToPlay:
            refreshAttempts = 0
            let secs = item.duration.seconds
            if secs.isFinite && secs > 0 { durationMs = Int(secs * 1000) }
            if let t = playRequestedAt, let a = current {
                let ms = Int(Date().timeIntervalSince(t) * 1000)
                playRequestedAt = nil
                Task { await backend?.track("playback_started", ["assetId": .string(a.id), "latencyMs": .int(ms)]) }
                Task { await backend?.track("stream_start_latency", ["latencyMs": .int(ms)]) }
            }
            updateNowPlaying()
        case .failed: recoverFromFailure()
        default: break
        }
    }

    /// Expired or revoked signed URLs surface as item failures: re-authorize once and resume at the same position.
    private func recoverFromFailure() {
        guard refreshAttempts < 2 else {
            phase = .failed("This audio can't be played right now.")
            if let a = current { Task { await backend?.track("playback_failed", ["assetId": .string(a.id), "errorCode": "ITEM_FAILED"]) } }
            return
        }
        refreshAttempts += 1
        let resumeAt = positionMs
        Task {
            try? await Task.sleep(nanoseconds: UInt64(500_000_000 * refreshAttempts))
            await loadCurrent(autoplay: true, forceRefresh: true, resumeAtMs: resumeAt)
        }
    }

    private func itemEnded() {
        if let a = current {
            Task { await backend?.saveProgress(a, positionMs: durationMs) }
            Task { await backend?.track("playback_completed", ["assetId": .string(a.id)]) }
        }
        if sleepTimer == .endOfItem { setSleepTimer(.off); pause(); return }
        if queue.repeatMode == .one { seek(toMs: 0); resume(); return }
        if queue.next(userInitiated: false) { Task { await loadCurrent(autoplay: true, resumeAtMs: 0) } } else { phase = .ended; persistProgress(force: true) }
    }

    private func tick(_ t: CMTime) {
        guard player.currentItem != nil, t.seconds.isFinite else { return }
        positionMs = Int(t.seconds * 1000)
        persistProgress(force: false)
        if Int(t.seconds) % 5 == 0 { updateNowPlaying() }
    }

    private func persistProgress(force: Bool) {
        guard let a = current, let backend else { return }
        if force || abs(positionMs - lastSavedMs) >= 10_000 {
            lastSavedMs = positionMs
            let pos = positionMs
            Task { await backend.saveProgress(a, positionMs: pos) }
        }
    }

    private func updateNowPlaying() {
        guard let a = current else { return }
        let pos = positionMs, dur = durationMs, r: Float = isPlaying ? rate : 0
        RemoteCommandRouter.shared.update(title: a.title, artist: a.creatorName, durationMs: dur, positionMs: pos, rate: r)
        Task { [weak self] in
            guard let img = await self?.backend?.artwork(for: a) else { return }
            RemoteCommandRouter.shared.update(title: a.title, artist: a.creatorName, durationMs: dur, positionMs: pos, rate: r, artwork: img)
        }
    }

    // MARK: RemoteControllable
    public func remotePlay() { resume() }
    public func remotePause() { pause() }
    public func remoteToggle() { toggle() }
    public func remoteNext() { next() }
    public func remotePrevious() { previous() }
    public func remoteSeek(toMs: Int) { seek(toMs: toMs) }
    public func remoteSkip(bySeconds: Double) { skip(bySeconds: bySeconds) }
    public var supportsSkipInterval: Bool { current?.assetType.isSpoken ?? false }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
