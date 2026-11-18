import Foundation
import Observation

/// Server-authoritative library with optimistic likes (rolled back on failure) and a local JSON cache for offline launch.
@MainActor
@Observable
public final class LibraryStore {
    public private(set) var likedIds: Set<String> = []
    public private(set) var snapshot: LibrarySnapshot?
    public private(set) var recent: [RecentItem] = []
    public var lastError: APIError?
    private let api: VibeFusionAPIProtocol
    private let cache: ResponseCache
    private var pending: Set<String> = []

    public init(api: VibeFusionAPIProtocol, cache: ResponseCache) {
        self.api = api
        self.cache = cache
        if let ids: [String] = cache.load("liked-ids") { likedIds = Set(ids) }
    }

    public func isLiked(_ id: String) -> Bool { likedIds.contains(id) }

    /// Optimistic toggle; returns the new state. Rolls back if the server rejects it.
    @discardableResult
    public func toggleLike(_ asset: Asset) async -> Bool {
        let id = asset.id
        guard !pending.contains(id) else { return likedIds.contains(id) }
        let wasLiked = likedIds.contains(id)
        pending.insert(id)
        defer { pending.remove(id) }
        if wasLiked { likedIds.remove(id) } else { likedIds.insert(id) }
        persist()
        do {
            if wasLiked { try await api.unlike(id) } else { try await api.like(id) }
            return !wasLiked
        } catch let e as APIError {
            if wasLiked { likedIds.insert(id) } else { likedIds.remove(id) }
            persist()
            lastError = e
            return wasLiked
        } catch {
            if wasLiked { likedIds.insert(id) } else { likedIds.remove(id) }
            persist()
            return wasLiked
        }
    }

    /// Pull the authoritative library (cross-device sync happens here: on launch, foreground and pull-to-refresh).
    public func refresh() async {
        do {
            let snap = try await api.library()
            snapshot = snap
            likedIds = Set((snap.likedMusic + snap.savedEpisodes).map(\.id))
            persist()
            recent = (try? await api.recent()) ?? recent
            lastError = nil
        } catch let e as APIError {
            lastError = e
        } catch {}
    }

    private func persist() { cache.save(Array(likedIds), key: "liked-ids") }
}

/// Tiny file-backed JSON cache for offline-first screens (no personal content beyond the user's own library ids).
public final class ResponseCache: @unchecked Sendable {
    private let dir: URL
    public init(directory: URL? = nil) {
        let base = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("vf-cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        dir = base
    }
    public func save<T: Encodable>(_ value: T, key: String) {
        if let d = try? JSONEncoder().encode(value) { try? d.write(to: dir.appendingPathComponent(key + ".json"), options: .atomic) }
    }
    public func load<T: Decodable>(_ key: String) -> T? {
        guard let d = try? Data(contentsOf: dir.appendingPathComponent(key + ".json")) else { return nil }
        return try? JSONDecoder().decode(T.self, from: d)
    }
    public func clear() { try? FileManager.default.removeItem(at: dir); try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
}
