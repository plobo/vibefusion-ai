import Foundation
import Observation
import SwiftData
import SwiftUI
import VFAudio
import VFCore

enum AppConfig {
    static let defaultBaseURL = URL(string: (Bundle.main.object(forInfoDictionaryKey: "VFAPIBaseURL") as? String) ?? "http://localhost:8080")!
    static var baseURL: URL {
        if let s = UserDefaults.standard.string(forKey: "vf.serverURL"), let u = URL(string: s), !s.isEmpty { return u }
        return defaultBaseURL
    }
}

enum SessionState: Equatable { case unknown, signedOut, guest, account }

/// Composition root (Swift-native DI): one instance, passed through the SwiftUI environment.
@MainActor
@Observable
final class AppEnvironment {
    let tokens: KeychainTokenStore
    let client: APIClient
    let api: VibeFusionAPI
    let cache = ResponseCache()
    let library: LibraryStore
    let downloads: DownloadManager
    let analytics: AnalyticsClient
    let backend: AppPlaybackBackend
    let player: StandardPlayer
    let fusion: FusionPlaybackEngine
    let container: ModelContainer

    var session: SessionState = .unknown
    var user: User?
    var preferences = Preferences()
    var fullPlayerPresented = false
    var nowPlaying: NowPlayingSource = .none
    var toast: String?
    var playlistTarget: Asset?

    enum NowPlayingSource: Equatable { case none, standard, fusion }

    /// Observed (drives RootView) and persisted.
    var onboarded: Bool = UserDefaults.standard.bool(forKey: "vf.onboarded") {
        didSet { UserDefaults.standard.set(onboarded, forKey: "vf.onboarded") }
    }
    @ObservationIgnored @AppStorage("vf.audioQuality") var audioQuality = "auto"
    @ObservationIgnored @AppStorage("vf.dataSaver") var dataSaver = false
    @ObservationIgnored @AppStorage("vf.downloadOnWifiOnly") var downloadOnWifiOnly = true

    init(inMemory: Bool = false) {
        tokens = KeychainTokenStore()
        #if DEBUG
        if ProcessInfo.processInfo.environment["VF_UITEST_RESET"] == "1" {
            tokens.clear()
            UserDefaults.standard.removeObject(forKey: "vf.onboarded")
            onboarded = false
        }
        #endif
        client = APIClient(baseURL: AppConfig.baseURL, tokens: tokens)
        api = VibeFusionAPI(client: client)
        container = (try? VFPersistence.makeContainer(inMemory: inMemory)) ?? (try! VFPersistence.makeContainer(inMemory: true))
        library = LibraryStore(api: api, cache: cache)
        downloads = DownloadManager(api: api, context: container.mainContext)
        analytics = AnalyticsClient(api: api)
        backend = AppPlaybackBackend(api: api, downloads: downloads, analytics: analytics, context: container.mainContext)
        player = StandardPlayer(backend: backend)
        fusion = FusionPlaybackEngine()
        player.onBecameActive = { [weak self] in self?.fusion.pause(); self?.nowPlaying = .standard }
        fusion.onBecameActive = { [weak self] in self?.player.pause(); self?.nowPlaying = .fusion }
        client.onSessionExpired = { [weak self] in Task { @MainActor in self?.session = .signedOut } }
        wireAudioSession()
        RemoteCommandRouter.shared.install()
    }

    private func wireAudioSession() {
        let s = AudioSessionController.shared
        s.onInterruptionBegan = { [weak self] in Task { @MainActor in self?.player.handleInterruptionBegan(); self?.fusion.handleInterruptionBegan() } }
        s.onInterruptionEnded = { [weak self] resume in
            Task { @MainActor in
                guard let self else { return }
                if self.nowPlaying == .fusion { self.fusion.handleInterruptionEnded(shouldResume: resume) } else { self.player.handleInterruptionEnded(shouldResume: resume) }
            }
        }
        s.onOldRouteUnavailable = { [weak self] in Task { @MainActor in self?.player.handleRouteLost(); self?.fusion.handleRouteLost() } }
        s.onMediaServicesReset = { [weak self] in Task { @MainActor in self?.fusion.handleMediaServicesReset() } }
    }

    // MARK: Session

    func bootstrap() async {
        guard tokens.refreshToken != nil else { session = .signedOut; return }
        do {
            let me = try await api.me()
            apply(me.user, prefs: me.preferences)
            await library.refresh()
            await backend.flushPendingProgress()
        } catch let e as APIError where e.isOffline {
            session = .account // offline launch: keep the session, show cached data
        } catch {
            session = .signedOut
        }
    }

    func apply(_ user: User, prefs: Preferences? = nil) {
        self.user = user
        if let prefs { preferences = prefs }
        client.territory = user.territory
        session = user.isGuest ? .guest : .account
        Task { await analytics.setEnabled(preferences.analyticsOptIn) }
    }

    func signedIn(_ tokens: Tokens) async {
        apply(tokens.user)
        if let me = try? await api.me() { apply(me.user, prefs: me.preferences) }
        await library.refresh()
    }

    func signOut() async {
        player.stop()
        fusion.release()
        await api.logout(refreshToken: tokens.refreshToken)
        cache.clear()
        user = nil
        session = .signedOut
    }

    func savePreferences(_ p: Preferences) async {
        preferences = p
        if let saved = try? await api.updatePreferences(p) { preferences = saved }
        await analytics.setEnabled(preferences.analyticsOptIn)
    }

    func play(_ items: [Asset], startAt: Int = 0) {
        player.play(items, startAt: startAt)
        nowPlaying = .standard
    }

    func flash(_ message: String) {
        toast = message
        Task { try? await Task.sleep(nanoseconds: 2_500_000_000); if toast == message { toast = nil } }
    }
}

/// Implements the player's backend seam: local downloads first, else short-lived signed URLs from the API.
@MainActor
final class AppPlaybackBackend: PlaybackBackend {
    private let api: VibeFusionAPIProtocol
    private let downloads: DownloadManager
    private let analytics: AnalyticsClient
    private let context: ModelContext
    private var artworkCache: [String: UIImage] = [:]

    init(api: VibeFusionAPIProtocol, downloads: DownloadManager, analytics: AnalyticsClient, context: ModelContext) {
        self.api = api; self.downloads = downloads; self.analytics = analytics; self.context = context
    }

    func resolve(_ asset: Asset, forceRefresh: Bool) async throws -> ResolvedMedia {
        if !forceRefresh, let local = downloads.localURL(for: asset.id) {
            let resume = (try? await api.authorize(assetId: asset.id, context: "stream").resumePositionMs) ?? 0
            return ResolvedMedia(url: local, resumePositionMs: resume, isLocal: true)
        }
        let auth = try await api.authorize(assetId: asset.id, context: "stream")
        guard let url = URL(string: auth.url) else { throw APIError.decoding }
        return ResolvedMedia(url: url, resumePositionMs: auth.resumePositionMs, isLocal: false)
    }

    func saveProgress(_ asset: Asset, positionMs: Int) async {
        do {
            try await api.saveProgress(assetId: asset.id, positionMs: positionMs, durationMs: asset.durationMs)
            await analytics.track("playback_progress_saved", ["assetId": .string(asset.id)])
        } catch {
            // Offline: keep the latest position in the outbox and flush later.
            let id = asset.id
            let existing = try? context.fetch(FetchDescriptor<PendingProgress>(predicate: #Predicate { $0.assetId == id }))
            if let row = existing?.first { row.positionMs = positionMs; row.updatedAt = Date() } else {
                context.insert(PendingProgress(assetId: id, positionMs: positionMs, durationMs: asset.durationMs))
            }
            try? context.save()
        }
    }

    func flushPendingProgress() async {
        guard let rows = try? context.fetch(FetchDescriptor<PendingProgress>()) else { return }
        for r in rows {
            if (try? await api.saveProgress(assetId: r.assetId, positionMs: r.positionMs, durationMs: r.durationMs)) != nil { context.delete(r) }
        }
        try? context.save()
    }

    func track(_ event: String, _ props: [String: AnalyticsValue]) async { await analytics.track(event, props) }

    func artwork(for asset: Asset) async -> UIImage? {
        if let c = artworkCache[asset.id] { return c }
        guard let url = asset.artwork, let (data, _) = try? await URLSession.shared.data(from: url), let img = UIImage(data: data) else { return nil }
        artworkCache[asset.id] = img
        return img
    }
}
