import Foundation

/// Typed endpoints (contracts/openapi.yaml). Views and view models depend on this protocol so tests can stub it.
public protocol VibeFusionAPIProtocol: Sendable {
    // Auth
    func register(email: String, password: String, displayName: String?) async throws -> Tokens
    func login(email: String, password: String) async throws -> Tokens
    func guest() async throws -> Tokens
    func upgrade(email: String, password: String) async throws -> Tokens
    func logout(refreshToken: String?) async
    func me() async throws -> Me
    func updatePreferences(_ p: Preferences) async throws -> Preferences
    func deleteAccount() async throws
    func exportData() async throws -> Data
    // Catalogue
    func home() async throws -> HomeResponse
    func catalogue(type: String?, genre: String?, mood: String?, topic: String?, mixable: Bool, cursor: String?) async throws -> Page<Asset>
    func asset(_ id: String) async throws -> Asset
    func creator(_ id: String) async throws -> CreatorDetail
    func genres() async throws -> [Tag]
    func moods() async throws -> [Tag]
    func collections() async throws -> [CatalogueCollection]
    func collection(_ idOrSlug: String) async throws -> CatalogueCollection
    func search(_ q: String, filters: SearchFilters) async throws -> SearchResults
    // Playback
    func authorize(assetId: String, context: String) async throws -> PlaybackAuthorization
    func saveProgress(assetId: String, positionMs: Int, durationMs: Int?) async throws
    func recent() async throws -> [RecentItem]
    func sendEvents(_ events: [AnalyticsEvent]) async throws
    // Library
    func library() async throws -> LibrarySnapshot
    func like(_ assetId: String) async throws
    func unlike(_ assetId: String) async throws
    func follow(showId: String, _ on: Bool) async throws
    func playlists() async throws -> [PlaylistSummary]
    func createPlaylist(name: String, assetIds: [String]) async throws -> Playlist
    func playlist(_ id: String) async throws -> Playlist
    func renamePlaylist(_ id: String, name: String, version: Int) async throws -> Playlist
    func deletePlaylist(_ id: String) async throws
    func addToPlaylist(_ id: String, assetId: String, version: Int) async throws -> Playlist
    func reorderPlaylist(_ id: String, itemIds: [String], version: Int) async throws -> Playlist
    func removeFromPlaylist(_ id: String, itemId: String, version: Int) async throws -> Playlist
    // Podcasts & motivation
    func podcasts(category: String?) async throws -> [Show]
    func show(_ id: String) async throws -> Show
    func episodes(showId: String, cursor: String?) async throws -> Page<EpisodeWithProgress>
    func episode(_ id: String) async throws -> EpisodeDetail
    func transcript(_ assetId: String) async throws -> [TranscriptSegment]
    func addBookmark(assetId: String, positionMs: Int, note: String?) async throws -> Bookmark
    func deleteBookmark(_ id: String) async throws
    func motivationTopics() async throws -> [Tag]
    func motivationFeatured(topic: String?) async throws -> MotivationFeatured
    // Fusion
    func fusionStatus() async throws -> FusionStatus
    func plan(_ req: FusionRequest) async throws -> FusionPlanResponse
    func validate(_ plan: MixPlan, requireExport: Bool) async throws -> ValidateResponse
    func recipes() async throws -> [MixRecipe]
    func recipe(_ id: String) async throws -> MixRecipe
    func saveRecipe(name: String, prompt: String?, plan: MixPlan, planner: String) async throws -> MixRecipe
    func updateRecipe(_ id: String, name: String?, plan: MixPlan?, version: Int) async throws -> MixRecipe
    func deleteRecipe(_ id: String) async throws
    func authorizeRecipe(_ id: String) async throws -> PlanAuthorization
    func authorizePreview(_ plan: MixPlan) async throws -> PlanAuthorization
    func render(recipeId: String) async throws -> RenderAuthorization
    func completeRender(jobId: String, ok: Bool, error: String?) async throws
    func share(recipeId: String) async throws -> ShareResponse
}

public final class VibeFusionAPI: VibeFusionAPIProtocol, @unchecked Sendable {
    public let client: APIClient
    public init(client: APIClient) { self.client = client }

    struct ItemsBox<T: Decodable & Sendable>: Decodable, Sendable { var items: [T] }

    public func register(email: String, password: String, displayName: String?) async throws -> Tokens {
        struct B: Encodable { var email: String; var password: String; var displayName: String?; var locale: String }
        let t: Tokens = try await client.request(.post, "/v1/auth/register", body: B(email: email, password: password, displayName: displayName, locale: Locale.current.identifier.replacingOccurrences(of: "_", with: "-")))
        client.tokens.save(access: t.accessToken, refresh: t.refreshToken); return t
    }
    public func login(email: String, password: String) async throws -> Tokens {
        let t: Tokens = try await client.request(.post, "/v1/auth/login", body: ["email": email, "password": password])
        client.tokens.save(access: t.accessToken, refresh: t.refreshToken); return t
    }
    public func guest() async throws -> Tokens {
        let t: Tokens = try await client.request(.post, "/v1/auth/guest")
        client.tokens.save(access: t.accessToken, refresh: t.refreshToken); return t
    }
    public func upgrade(email: String, password: String) async throws -> Tokens {
        let t: Tokens = try await client.request(.post, "/v1/auth/upgrade", body: ["email": email, "password": password])
        client.tokens.save(access: t.accessToken, refresh: t.refreshToken); return t
    }
    public func logout(refreshToken: String?) async {
        try? await client.send(.post, "/v1/auth/logout", body: ["refreshToken": refreshToken ?? ""])
        client.tokens.clear()
    }
    public func me() async throws -> Me { try await client.request(.get, "/v1/me") }
    public func updatePreferences(_ p: Preferences) async throws -> Preferences { try await client.request(.put, "/v1/me/preferences", body: p) }
    public func deleteAccount() async throws { try await client.send(.delete, "/v1/me"); client.tokens.clear() }
    public func exportData() async throws -> Data { try await client.raw(.get, "/v1/me/export") }

    public func home() async throws -> HomeResponse { try await client.request(.get, "/v1/home") }
    public func catalogue(type: String?, genre: String?, mood: String?, topic: String?, mixable: Bool, cursor: String?) async throws -> Page<Asset> {
        try await client.request(.get, "/v1/catalogue", query: ["type": type, "genre": genre, "mood": mood, "topic": topic, "mixable": mixable ? "true" : nil, "cursor": cursor, "limit": "20"])
    }
    public func asset(_ id: String) async throws -> Asset { try await client.request(.get, "/v1/assets/\(id)") }
    public func creator(_ id: String) async throws -> CreatorDetail { try await client.request(.get, "/v1/creators/\(id)") }
    public func genres() async throws -> [Tag] { (try await client.request(.get, "/v1/genres") as ItemsBox<Tag>).items }
    public func moods() async throws -> [Tag] { (try await client.request(.get, "/v1/moods") as ItemsBox<Tag>).items }
    public func collections() async throws -> [CatalogueCollection] { (try await client.request(.get, "/v1/collections") as ItemsBox<CatalogueCollection>).items }
    public func collection(_ idOrSlug: String) async throws -> CatalogueCollection { try await client.request(.get, "/v1/collections/\(idOrSlug)") }
    public func search(_ q: String, filters: SearchFilters) async throws -> SearchResults {
        try await client.request(.get, "/v1/search", query: [
            "q": q, "content": filters.content == .all ? nil : filters.content.rawValue, "genre": filters.genre, "mood": filters.mood,
            "maxDurationMs": filters.maxDurationMinutes.map { String($0 * 60_000) }, "language": filters.language,
        ], retries: 0)
    }

    public func authorize(assetId: String, context: String) async throws -> PlaybackAuthorization {
        try await client.request(.post, "/v1/playback/authorize", body: ["assetId": assetId, "context": context], retries: 2)
    }
    public func saveProgress(assetId: String, positionMs: Int, durationMs: Int?) async throws {
        struct B: Encodable { var assetId: String; var positionMs: Int; var durationMs: Int? }
        try await client.send(.post, "/v1/playback/progress", body: B(assetId: assetId, positionMs: max(0, positionMs), durationMs: durationMs))
    }
    public func recent() async throws -> [RecentItem] { (try await client.request(.get, "/v1/playback/recent") as ItemsBox<RecentItem>).items }
    public func sendEvents(_ events: [AnalyticsEvent]) async throws {
        struct B: Encodable { var platform = "ios"; var events: [AnalyticsEvent] }
        try await client.send(.post, "/v1/playback/events", body: B(events: events))
    }

    public func library() async throws -> LibrarySnapshot { try await client.request(.get, "/v1/library") }
    public func like(_ assetId: String) async throws { try await client.send(.put, "/v1/library/likes/\(assetId)") }
    public func unlike(_ assetId: String) async throws { try await client.send(.delete, "/v1/library/likes/\(assetId)") }
    public func follow(showId: String, _ on: Bool) async throws { try await client.send(on ? .put : .delete, "/v1/podcasts/\(showId)/follow") }
    public func playlists() async throws -> [PlaylistSummary] { (try await client.request(.get, "/v1/playlists") as ItemsBox<PlaylistSummary>).items }
    public func createPlaylist(name: String, assetIds: [String]) async throws -> Playlist {
        struct B: Encodable { var name: String; var assetIds: [String] }
        return try await client.request(.post, "/v1/playlists", body: B(name: name, assetIds: assetIds), headers: ["Idempotency-Key": UUID().uuidString])
    }
    public func playlist(_ id: String) async throws -> Playlist { try await client.request(.get, "/v1/playlists/\(id)") }
    public func renamePlaylist(_ id: String, name: String, version: Int) async throws -> Playlist {
        try await client.request(.patch, "/v1/playlists/\(id)", body: ["name": name], headers: ["If-Match": "\"\(version)\""])
    }
    public func deletePlaylist(_ id: String) async throws { try await client.send(.delete, "/v1/playlists/\(id)") }
    public func addToPlaylist(_ id: String, assetId: String, version: Int) async throws -> Playlist {
        struct B: Encodable { var assetId: String; var version: Int }
        return try await client.request(.post, "/v1/playlists/\(id)/items", body: B(assetId: assetId, version: version))
    }
    public func reorderPlaylist(_ id: String, itemIds: [String], version: Int) async throws -> Playlist {
        struct B: Encodable { var itemIds: [String]; var version: Int }
        return try await client.request(.patch, "/v1/playlists/\(id)/items/reorder", body: B(itemIds: itemIds, version: version))
    }
    public func removeFromPlaylist(_ id: String, itemId: String, version: Int) async throws -> Playlist {
        try await client.request(.delete, "/v1/playlists/\(id)/items/\(itemId)", query: ["version": String(version)])
    }

    public func podcasts(category: String?) async throws -> [Show] { (try await client.request(.get, "/v1/podcasts", query: ["category": category]) as ItemsBox<Show>).items }
    public func show(_ id: String) async throws -> Show { try await client.request(.get, "/v1/podcasts/\(id)") }
    public func episodes(showId: String, cursor: String?) async throws -> Page<EpisodeWithProgress> {
        try await client.request(.get, "/v1/podcasts/\(showId)/episodes", query: ["cursor": cursor])
    }
    public func episode(_ id: String) async throws -> EpisodeDetail { try await client.request(.get, "/v1/episodes/\(id)") }
    public func transcript(_ assetId: String) async throws -> [TranscriptSegment] {
        struct R: Decodable { var segments: [TranscriptSegment] }
        return (try await client.request(.get, "/v1/assets/\(assetId)/transcript") as R).segments
    }
    public func addBookmark(assetId: String, positionMs: Int, note: String?) async throws -> Bookmark {
        struct B: Encodable { var positionMs: Int; var note: String? }
        return try await client.request(.post, "/v1/assets/\(assetId)/bookmarks", body: B(positionMs: positionMs, note: note))
    }
    public func deleteBookmark(_ id: String) async throws { try await client.send(.delete, "/v1/bookmarks/\(id)") }
    public func motivationTopics() async throws -> [Tag] { (try await client.request(.get, "/v1/motivation/topics") as ItemsBox<Tag>).items }
    public func motivationFeatured(topic: String?) async throws -> MotivationFeatured { try await client.request(.get, "/v1/motivation/featured", query: ["topic": topic]) }

    public func fusionStatus() async throws -> FusionStatus { try await client.request(.get, "/v1/fusion/status") }
    public func plan(_ req: FusionRequest) async throws -> FusionPlanResponse { try await client.request(.post, "/v1/fusion/plan", body: req) }
    public func validate(_ plan: MixPlan, requireExport: Bool) async throws -> ValidateResponse {
        struct B: Encodable { var plan: MixPlan; var requireExport: Bool }
        return try await client.request(.post, "/v1/fusion/validate", body: B(plan: plan, requireExport: requireExport))
    }
    public func recipes() async throws -> [MixRecipe] { (try await client.request(.get, "/v1/fusion/recipes") as ItemsBox<MixRecipe>).items }
    public func recipe(_ id: String) async throws -> MixRecipe { try await client.request(.get, "/v1/fusion/recipes/\(id)") }
    public func saveRecipe(name: String, prompt: String?, plan: MixPlan, planner: String) async throws -> MixRecipe {
        struct B: Encodable { var name: String; var prompt: String?; var plan: MixPlan; var planner: String }
        return try await client.request(.post, "/v1/fusion/recipes", body: B(name: name, prompt: prompt, plan: plan, planner: planner), headers: ["Idempotency-Key": UUID().uuidString])
    }
    public func updateRecipe(_ id: String, name: String?, plan: MixPlan?, version: Int) async throws -> MixRecipe {
        struct B: Encodable { var name: String?; var plan: MixPlan?; var version: Int }
        return try await client.request(.patch, "/v1/fusion/recipes/\(id)", body: B(name: name, plan: plan, version: version))
    }
    public func deleteRecipe(_ id: String) async throws { try await client.send(.delete, "/v1/fusion/recipes/\(id)") }
    public func authorizeRecipe(_ id: String) async throws -> PlanAuthorization { try await client.request(.post, "/v1/fusion/recipes/\(id)/playback-authorize", body: Empty()) }
    public func authorizePreview(_ plan: MixPlan) async throws -> PlanAuthorization {
        struct B: Encodable { var plan: MixPlan }
        return try await client.request(.post, "/v1/fusion/preview-authorize", body: B(plan: plan))
    }
    public func render(recipeId: String) async throws -> RenderAuthorization {
        try await client.request(.post, "/v1/fusion/render", body: ["recipeId": recipeId], headers: ["Idempotency-Key": UUID().uuidString])
    }
    public func completeRender(jobId: String, ok: Bool, error: String?) async throws {
        struct B: Encodable { var status: String; var error: String? }
        try await client.send(.post, "/v1/fusion/render-jobs/\(jobId)/complete", body: B(status: ok ? "completed" : "failed", error: error))
    }
    public func share(recipeId: String) async throws -> ShareResponse { try await client.request(.post, "/v1/fusion/recipes/\(recipeId)/share", body: Empty()) }
}
