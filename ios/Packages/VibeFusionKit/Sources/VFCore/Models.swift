import Foundation

// MARK: - Catalogue

public struct Capabilities: Codable, Hashable, Sendable {
    public var stream: Bool
    public var download: Bool
    public var mix: Bool
    public var render: Bool
    public init(stream: Bool = true, download: Bool = false, mix: Bool = false, render: Bool = false) {
        self.stream = stream; self.download = download; self.mix = mix; self.render = render
    }
}

public struct License: Codable, Hashable, Sendable {
    public var type: String
    public var url: String?
    public var attribution: String?
    public var rightsHolder: String
}

public struct CreatorRef: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var creatorType: String
}

public struct Chapter: Codable, Hashable, Sendable {
    public var startMs: Int
    public var title: String
}

public enum AssetType: String, Codable, Sendable {
    case music, speech, podcastEpisode = "podcast_episode", loop, stem, soundEffect = "sound_effect"
    public var isSpoken: Bool { self == .speech || self == .podcastEpisode }
}

public struct Asset: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var subtitle: String?
    public var description: String?
    public var assetType: AssetType
    public var creatorId: String?
    public var creator: CreatorRef?
    public var showId: String?
    public var showTitle: String?
    public var durationMs: Int
    public var artworkUrl: String?
    public var streamingFormat: String
    public var language: String
    public var genres: [String]
    public var moods: [String]
    public var topics: [String]
    public var tempoBpm: Double?
    public var key: String?
    public var isExplicit: Bool
    public var isActive: Bool
    public var isDevFixture: Bool?
    public var releaseDate: String?
    public var episodeNumber: Int?
    public var capabilities: Capabilities
    public var license: License?
    // Detail-only fields
    public var chapters: [Chapter]?
    public var hasTranscript: Bool?
    public var liked: Bool?

    public var artwork: URL? { artworkUrl.flatMap(URL.init(string:)) }
    public var creatorName: String { creator?.name ?? subtitle ?? showTitle ?? "" }

    public init(id: String, title: String, assetType: AssetType, durationMs: Int, capabilities: Capabilities = .init(),
                subtitle: String? = nil, genres: [String] = [], moods: [String] = [], topics: [String] = [],
                tempoBpm: Double? = nil, key: String? = nil, artworkUrl: String? = nil) {
        self.id = id; self.title = title; self.assetType = assetType; self.durationMs = durationMs
        self.capabilities = capabilities; self.subtitle = subtitle; self.genres = genres; self.moods = moods
        self.topics = topics; self.tempoBpm = tempoBpm; self.key = key; self.artworkUrl = artworkUrl
        self.streamingFormat = "progressive"; self.language = "en"; self.isExplicit = false; self.isActive = true
    }
}

public struct Show: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var description: String?
    public var artworkUrl: String?
    public var showKind: String?
    public var creatorName: String?
    public var creatorId: String?
    public var episodeCount: Int?
    public var categories: [String]?
    public var following: Bool?
    public var artwork: URL? { artworkUrl.flatMap(URL.init(string:)) }
}

public struct Tag: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var assetCount: Int?
}

public struct MixSummary: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var durationMs: Int
    public var rightsValidationStatus: String?
    public var updatedAt: String?
}

public enum ShelfItems: Hashable, Sendable {
    case assets([Asset]), shows([Show]), mixes([MixSummary]), topics([Tag])
}

public struct Shelf: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var kind: String
    public var items: ShelfItems

    enum CodingKeys: String, CodingKey { case id, title, kind, items }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "shows": items = .shows(try c.decode([Show].self, forKey: .items))
        case "mixes": items = .mixes(try c.decode([MixSummary].self, forKey: .items))
        case "topics": items = .topics(try c.decode([Tag].self, forKey: .items))
        default: items = .assets(try c.decode([Asset].self, forKey: .items))
        }
    }
}

public struct HomeResponse: Decodable, Sendable {
    public var greeting: String
    public var shelves: [Shelf]
}

public struct Page<T: Decodable & Sendable>: Decodable, Sendable {
    public var items: [T]
    public var nextCursor: String?
}

public struct ItemsResponse<T: Decodable & Sendable>: Decodable, Sendable {
    public var items: [T]
}

public struct CatalogueCollection: Decodable, Identifiable, Sendable {
    public var id: String
    public var slug: String?
    public var title: String
    public var description: String?
    public var artworkUrl: String?
    public var items: [Asset]?
    public var itemCount: Int?
}

public struct CreatorDetail: Decodable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var creatorType: String
    public var bio: String?
    public var imageUrl: String?
    public var assets: [Asset]
    public var shows: [Show]
    public var following: Bool
}

public struct SearchResults: Decodable, Sendable {
    public struct Album: Decodable, Hashable, Identifiable, Sendable { public var id: String; public var title: String; public var artworkUrl: String?; public var creatorName: String? }
    public struct Artist: Decodable, Hashable, Identifiable, Sendable { public var id: String; public var name: String; public var creatorType: String }
    public var query: String
    public var tracks: [Asset]
    public var albums: [Album]
    public var artists: [Artist]
    public var shows: [Show]
    public var episodes: [Asset]
    public var speeches: [Asset]
    public var isEmpty: Bool { tracks.isEmpty && albums.isEmpty && artists.isEmpty && shows.isEmpty && episodes.isEmpty && speeches.isEmpty }
}

public struct SearchFilters: Equatable, Sendable {
    public enum Content: String, CaseIterable, Sendable { case all, music, spoken }
    public var content: Content = .all
    public var genre: String?
    public var mood: String?
    public var maxDurationMinutes: Int?
    public var language: String?
    public init() {}
}

// MARK: - Podcasts & speech

public struct TranscriptSegment: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var startMs: Int
    public var endMs: Int
    public var text: String
    public var speaker: String?
}

public struct Bookmark: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var assetId: String
    public var positionMs: Int
    public var note: String?
    public var createdAt: String?
    public var shareUrl: String?
}

public struct ProgressState: Codable, Hashable, Sendable {
    public var positionMs: Int
    public var completed: Bool
}

public struct EpisodeDetail: Decodable, Sendable {
    public var asset: Asset
    public var chapters: [Chapter]
    public var bookmarks: [Bookmark]
    public var progress: ProgressState?
    public var hasTranscript: Bool
    enum CodingKeys: String, CodingKey { case chapters, bookmarks, progress, hasTranscript }
    public init(from decoder: Decoder) throws {
        asset = try Asset(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chapters = try c.decodeIfPresent([Chapter].self, forKey: .chapters) ?? []
        bookmarks = try c.decodeIfPresent([Bookmark].self, forKey: .bookmarks) ?? []
        progress = try c.decodeIfPresent(ProgressState.self, forKey: .progress)
        hasTranscript = try c.decodeIfPresent(Bool.self, forKey: .hasTranscript) ?? false
    }
}

public struct EpisodeWithProgress: Decodable, Identifiable, Sendable {
    public var asset: Asset
    public var progress: ProgressState?
    public var id: String { asset.id }
    enum CodingKeys: String, CodingKey { case progress }
    public init(from decoder: Decoder) throws {
        asset = try Asset(from: decoder)
        progress = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(ProgressState.self, forKey: .progress)
    }
}

public struct MotivationFeatured: Decodable, Sendable {
    public var featured: Asset?
    public var short: [Asset]
    public var long: [Asset]
    public var speakers: [CreatorRef]
}

// MARK: - Library

public struct PlaylistSummary: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var description: String?
    public var visibility: String?
    public var version: Int
    public var itemCount: Int?
}

public struct PlaylistItem: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var playlistId: String
    public var assetId: String
    public var position: Int
    public var asset: Asset?
}

public struct Playlist: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var description: String?
    public var artworkUrl: String?
    public var visibility: String
    public var version: Int
    public var items: [PlaylistItem]
}

public struct LibrarySnapshot: Decodable, Sendable {
    public var likedMusic: [Asset]
    public var savedEpisodes: [Asset]
    public var playlists: [PlaylistSummary]
    public var mixes: [MixSummary]
    public var followedShows: [Show]
    public var syncedAt: String
}

public struct RecentItem: Decodable, Identifiable, Sendable {
    public var asset: Asset
    public var positionMs: Int
    public var completed: Bool
    public var playedAt: String
    public var id: String { asset.id + playedAt }
}

// MARK: - Account

public struct User: Codable, Hashable, Sendable {
    public var id: String
    public var email: String?
    public var displayName: String
    public var locale: String
    public var territory: String
    public var isGuest: Bool
    public var isAdmin: Bool
}

public struct Preferences: Codable, Hashable, Sendable {
    public var genres: [String] = []
    public var moods: [String] = []
    public var speechTopics: [String] = []
    public var explicitAllowed: Bool = false
    public var analyticsOptIn: Bool = true
    public var aiProcessingConsent: Bool = false
    public init() {}
}

public struct Me: Decodable, Sendable {
    public var user: User
    public var preferences: Preferences
    enum CodingKeys: String, CodingKey { case preferences }
    public init(from decoder: Decoder) throws {
        user = try User(from: decoder)
        preferences = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(Preferences.self, forKey: .preferences) ?? Preferences()
    }
}

public struct Tokens: Codable, Sendable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresIn: Int
    public var user: User
}

// MARK: - Playback

public struct MediaGrant: Codable, Hashable, Sendable {
    public var assetId: String
    public var url: String
    public var expiresAt: String
    public var mimeType: String
    public var format: String
    public var purpose: String
}

public struct PlaybackAuthorization: Decodable, Sendable {
    public var assetId: String
    public var url: String
    public var expiresAt: String
    public var mimeType: String
    public var resumePositionMs: Int
    public var attribution: String?
}

// MARK: - Fusion

public struct FusionStatus: Decodable, Sendable {
    public var aiAvailable: Bool
    public var provider: String
    public var manualEditorAvailable: Bool
    public var maxLayers: Int
    public var disclosure: String
}

public struct FusionRequest: Encodable, Sendable {
    public var prompt: String
    public var targetDurationMs: Int
    public var mood: String?
    public var energyCurve: String?
    public var genres: [String]?
    public var includeSpeech: Bool?
    public var speechTopic: String?
    public var availableAssetIds: [String]?
    public var constraints: Constraints?
    public struct Constraints: Encodable, Sendable { public var maxLayers: Int?; public var allowLoops: Bool?
        public init(maxLayers: Int? = nil, allowLoops: Bool? = nil) { self.maxLayers = maxLayers; self.allowLoops = allowLoops } }
    public init(prompt: String, targetDurationMs: Int, mood: String? = nil, energyCurve: String? = nil, genres: [String]? = nil,
                includeSpeech: Bool? = nil, speechTopic: String? = nil, availableAssetIds: [String]? = nil, constraints: Constraints? = nil) {
        self.prompt = prompt; self.targetDurationMs = targetDurationMs; self.mood = mood; self.energyCurve = energyCurve
        self.genres = genres; self.includeSpeech = includeSpeech; self.speechTopic = speechTopic
        self.availableAssetIds = availableAssetIds; self.constraints = constraints
    }
}

public struct ValidationIssue: Codable, Hashable, Sendable {
    public var code: String
    public var message: String
    public var layerId: String?
    public var assetId: String?
}

public struct PlanValidation: Codable, Hashable, Sendable {
    public var schemaValid: Bool
    public var valid: Bool
    public var rightsStatus: String
    public var errors: [ValidationIssue]
    public var warnings: [String]
    public init(schemaValid: Bool, valid: Bool, rightsStatus: String, errors: [ValidationIssue], warnings: [String]) {
        self.schemaValid = schemaValid; self.valid = valid; self.rightsStatus = rightsStatus; self.errors = errors; self.warnings = warnings
    }
}

public struct FusionPlanResponse: Decodable, Sendable {
    public var plan: MixPlan
    public var provider: String
    public var warnings: [String]
    public var assets: [Asset]
    public var validation: PlanValidation
}

public struct ValidateResponse: Decodable, Sendable {
    public var schemaValid: Bool
    public var valid: Bool
    public var rightsStatus: String
    public var errors: [ValidationIssue]
    public var warnings: [String]
    public var plan: MixPlan?
    public var assets: [Asset]?
}

public struct MixRecipe: Decodable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var prompt: String?
    public var durationMs: Int
    public var mixPlan: MixPlan
    public var rightsValidationStatus: String
    public var planner: String
    public var version: Int
    public var assets: [Asset]?
    public var validation: PlanValidation?
}

public struct BlockedLayer: Decodable, Hashable, Sendable {
    public var layerId: String
    public var assetId: String
    public var reason: String
    public var message: String
}

public struct PlanAuthorization: Decodable, Sendable {
    public struct AssetInfo: Decodable, Hashable, Sendable { public var id: String; public var title: String; public var durationMs: Int; public var artworkUrl: String?; public var attribution: String? }
    public var plan: MixPlan
    public var media: [String: MediaGrant]
    public var blockedLayers: [BlockedLayer]
    public var assets: [AssetInfo]
}

public struct RenderAuthorization: Decodable, Sendable {
    public var jobId: String
    public var status: String
    public var attribution: String?
    public var media: [MediaGrant]
    public var plan: MixPlan
}

public struct ShareResponse: Decodable, Sendable { public var token: String; public var url: String }
