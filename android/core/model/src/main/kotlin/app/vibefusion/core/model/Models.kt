package app.vibefusion.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Shared JSON configuration (wire format from contracts/openapi.yaml). */
val VfJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
}

@Serializable
data class Capabilities(val stream: Boolean = true, val download: Boolean = false, val mix: Boolean = false, val render: Boolean = false)

@Serializable
data class License(val type: String, val url: String? = null, val attribution: String? = null, val rightsHolder: String = "")

@Serializable
data class CreatorRef(val id: String, val name: String, val creatorType: String = "artist")

@Serializable
data class Chapter(val startMs: Int, val title: String)

@Serializable
data class Asset(
    val id: String,
    val title: String,
    val subtitle: String? = null,
    val description: String? = null,
    val assetType: String,
    val creatorId: String? = null,
    val creator: CreatorRef? = null,
    val showId: String? = null,
    val showTitle: String? = null,
    val durationMs: Int = 0,
    val artworkUrl: String? = null,
    val streamingFormat: String = "progressive",
    val language: String = "en",
    val genres: List<String> = emptyList(),
    val moods: List<String> = emptyList(),
    val topics: List<String> = emptyList(),
    val tempoBpm: Double? = null,
    val key: String? = null,
    val isExplicit: Boolean = false,
    val isActive: Boolean = true,
    val isDevFixture: Boolean = false,
    val releaseDate: String? = null,
    val episodeNumber: Int? = null,
    val capabilities: Capabilities = Capabilities(),
    val license: License? = null,
    val chapters: List<Chapter>? = null,
    val hasTranscript: Boolean? = null,
    val liked: Boolean? = null,
    // Episode list extras
    val progress: ProgressState? = null,
) {
    val isSpoken: Boolean get() = assetType == "speech" || assetType == "podcast_episode"
    val creatorName: String get() = creator?.name ?: subtitle ?: showTitle ?: ""
}

@Serializable
data class Show(
    val id: String,
    val title: String,
    val description: String? = null,
    val artworkUrl: String? = null,
    val showKind: String? = null,
    val creatorName: String? = null,
    val creatorId: String? = null,
    val episodeCount: Int? = null,
    val categories: List<String>? = null,
    val following: Boolean? = null,
)

@Serializable
data class Tag(val id: String, val name: String, val assetCount: Int? = null)

@Serializable
data class MixSummary(val id: String, val name: String, val durationMs: Int, val rightsValidationStatus: String? = null)

/** Home shelf; items are decoded by `kind` (assets | shows | mixes | topics). */
@Serializable
data class RawShelf(val id: String, val title: String, val kind: String, val items: List<JsonElement>)

sealed interface ShelfItems {
    data class Assets(val items: List<Asset>) : ShelfItems
    data class Shows(val items: List<Show>) : ShelfItems
    data class Mixes(val items: List<MixSummary>) : ShelfItems
    data class Topics(val items: List<Tag>) : ShelfItems
}

data class Shelf(val id: String, val title: String, val items: ShelfItems)

@Serializable
data class HomeResponse(val greeting: String, val shelves: List<RawShelf>) {
    fun decoded(): List<Shelf> = shelves.map { s ->
        fun <T> list(ser: KSerializer<T>) = s.items.map { VfJson.decodeFromJsonElement(ser, it) }
        val items = when (s.kind) {
            "shows" -> ShelfItems.Shows(list(Show.serializer()))
            "mixes" -> ShelfItems.Mixes(list(MixSummary.serializer()))
            "topics" -> ShelfItems.Topics(list(Tag.serializer()))
            else -> ShelfItems.Assets(list(Asset.serializer()))
        }
        Shelf(s.id, s.title, items)
    }
}

@Serializable data class Page<T>(val items: List<T>, val nextCursor: String? = null)
@Serializable data class Items<T>(val items: List<T>)

@Serializable
data class CatalogueCollection(
    val id: String,
    val slug: String? = null,
    val title: String,
    val description: String? = null,
    val artworkUrl: String? = null,
    val items: List<Asset>? = null,
    val itemCount: Int? = null,
)

@Serializable
data class CreatorDetail(
    val id: String,
    val name: String,
    val creatorType: String,
    val bio: String? = null,
    val assets: List<Asset> = emptyList(),
    val shows: List<Show> = emptyList(),
    val following: Boolean = false,
)

@Serializable data class Album(val id: String, val title: String, val artworkUrl: String? = null, val creatorName: String? = null)
@Serializable data class Artist(val id: String, val name: String, val creatorType: String = "artist")

@Serializable
data class SearchResults(
    val query: String,
    val tracks: List<Asset> = emptyList(),
    val albums: List<Album> = emptyList(),
    val artists: List<Artist> = emptyList(),
    val shows: List<Show> = emptyList(),
    val episodes: List<Asset> = emptyList(),
    val speeches: List<Asset> = emptyList(),
) {
    val isEmpty get() = tracks.isEmpty() && albums.isEmpty() && artists.isEmpty() && shows.isEmpty() && episodes.isEmpty() && speeches.isEmpty()
}

data class SearchFilters(
    val content: String? = null, // music | spoken
    val genre: String? = null,
    val mood: String? = null,
    val maxDurationMinutes: Int? = null,
    val language: String? = null,
)

@Serializable data class TranscriptSegment(val id: String, val startMs: Int, val endMs: Int, val text: String, val speaker: String? = null)
@Serializable data class Transcript(val assetId: String, val segments: List<TranscriptSegment>)
@Serializable data class Bookmark(val id: String, val assetId: String, val positionMs: Int, val note: String? = null, val createdAt: String? = null, val shareUrl: String? = null)
@Serializable data class ProgressState(val positionMs: Int = 0, val completed: Boolean = false)
@Serializable data class ProgressResponse(val assetId: String, val positionMs: Int = 0, val completed: Boolean = false)

@Serializable
data class EpisodeDetail(
    val id: String,
    val title: String,
    val assetType: String,
    val durationMs: Int = 0,
    val chapters: List<Chapter> = emptyList(),
    val bookmarks: List<Bookmark> = emptyList(),
    val progress: ProgressState? = null,
    val hasTranscript: Boolean = false,
)

@Serializable data class MotivationFeatured(val featured: Asset? = null, val short: List<Asset> = emptyList(), val long: List<Asset> = emptyList(), val speakers: List<CreatorRef> = emptyList())

@Serializable data class PlaylistSummary(val id: String, val name: String, val description: String? = null, val visibility: String? = null, val version: Int, val itemCount: Int? = null)
@Serializable data class PlaylistItem(val id: String, val playlistId: String, val assetId: String, val position: Int, val asset: Asset? = null)
@Serializable data class Playlist(val id: String, val name: String, val description: String? = null, val visibility: String = "private", val version: Int, val items: List<PlaylistItem> = emptyList())

@Serializable
data class LibrarySnapshot(
    val likedMusic: List<Asset> = emptyList(),
    val savedEpisodes: List<Asset> = emptyList(),
    val playlists: List<PlaylistSummary> = emptyList(),
    val mixes: List<MixSummary> = emptyList(),
    val followedShows: List<Show> = emptyList(),
    val syncedAt: String = "",
)

@Serializable data class RecentItem(val asset: Asset, val positionMs: Int, val completed: Boolean, val playedAt: String)

@Serializable
data class User(
    val id: String,
    val email: String? = null,
    val displayName: String,
    val locale: String = "en-CA",
    val territory: String = "CA",
    val isGuest: Boolean = false,
    val isAdmin: Boolean = false,
)

@Serializable
data class Preferences(
    val genres: List<String> = emptyList(),
    val moods: List<String> = emptyList(),
    val speechTopics: List<String> = emptyList(),
    val explicitAllowed: Boolean = false,
    val analyticsOptIn: Boolean = true,
    val aiProcessingConsent: Boolean = false,
)

@Serializable
data class Me(
    val id: String,
    val email: String? = null,
    val displayName: String,
    val locale: String = "en-CA",
    val territory: String = "CA",
    val isGuest: Boolean = false,
    val isAdmin: Boolean = false,
    val preferences: Preferences = Preferences(),
) {
    fun user() = User(id, email, displayName, locale, territory, isGuest, isAdmin)
}

@Serializable data class Tokens(val accessToken: String, val refreshToken: String, val expiresIn: Int, val user: User)

@Serializable
data class MediaGrant(val assetId: String, val url: String, val expiresAt: String, val mimeType: String = "audio/mpeg", val format: String = "progressive", val purpose: String = "stream")

@Serializable
data class PlaybackAuthorization(val assetId: String, val url: String, val expiresAt: String, val mimeType: String = "audio/mpeg", val resumePositionMs: Int = 0, val attribution: String? = null)

@Serializable data class FusionStatus(val aiAvailable: Boolean, val provider: String, val manualEditorAvailable: Boolean, val maxLayers: Int, val disclosure: String)

@Serializable
data class FusionRequest(
    val prompt: String,
    val targetDurationMs: Int,
    val mood: String? = null,
    val energyCurve: String? = null,
    val genres: List<String>? = null,
    val includeSpeech: Boolean? = null,
    val speechTopic: String? = null,
    val availableAssetIds: List<String>? = null,
    val constraints: Constraints? = null,
) {
    @Serializable data class Constraints(val maxLayers: Int? = null, val allowLoops: Boolean? = null)
}

@Serializable data class ValidationIssue(val code: String, val message: String, val layerId: String? = null, val assetId: String? = null)
@Serializable data class PlanValidation(val schemaValid: Boolean = true, val valid: Boolean, val rightsStatus: String, val errors: List<ValidationIssue> = emptyList(), val warnings: List<String> = emptyList())
@Serializable data class FusionPlanResponse(val plan: MixPlan, val provider: String, val warnings: List<String> = emptyList(), val assets: List<Asset> = emptyList(), val validation: PlanValidation)

@Serializable
data class ValidateResponse(
    val schemaValid: Boolean,
    val valid: Boolean,
    val rightsStatus: String,
    val errors: List<ValidationIssue> = emptyList(),
    val warnings: List<String> = emptyList(),
    val plan: MixPlan? = null,
    val assets: List<Asset> = emptyList(),
) {
    fun toValidation() = PlanValidation(schemaValid, valid, rightsStatus, errors, warnings)
}

@Serializable
data class MixRecipe(
    val id: String,
    val name: String,
    val prompt: String? = null,
    val durationMs: Int,
    val mixPlan: MixPlan,
    val rightsValidationStatus: String,
    val planner: String = "manual",
    val version: Int,
    val assets: List<Asset>? = null,
    val validation: PlanValidation? = null,
)

@Serializable data class BlockedLayer(val layerId: String, val assetId: String, val reason: String, val message: String)
@Serializable data class AssetInfo(val id: String, val title: String, val durationMs: Int, val artworkUrl: String? = null, val attribution: String? = null)
@Serializable data class PlanAuthorization(val plan: MixPlan, val media: Map<String, MediaGrant>, val blockedLayers: List<BlockedLayer> = emptyList(), val assets: List<AssetInfo> = emptyList())
@Serializable data class RenderAuthorization(val jobId: String, val status: String, val attribution: String? = null, val media: List<MediaGrant>, val plan: MixPlan)
@Serializable data class ShareResponse(val token: String, val url: String)

/** Error surfaced to UI; mirrors the server error envelope. */
data class ApiError(val code: String, override val message: String, val status: Int, val retryable: Boolean, val requestId: String? = null) : Exception(message) {
    val isOffline get() = code == "NETWORK"
    companion object {
        fun network() = ApiError("NETWORK", "You appear to be offline. Check your connection and try again.", 0, true)
        fun parse(status: Int, body: String?): ApiError = try {
            val e = VfJson.parseToJsonElement(body ?: "").jsonObject["error"]!!.jsonObject
            ApiError(
                e["code"]!!.jsonPrimitive.content,
                e["message"]!!.jsonPrimitive.content,
                status,
                e["retryable"]?.jsonPrimitive?.content == "true",
                e["requestId"]?.jsonPrimitive?.content,
            )
        } catch (_: Exception) {
            ApiError("HTTP_$status", "Request failed ($status).", status, status >= 500)
        }
    }
}

@Serializable data class AnalyticsEvent(val name: String, val occurredAt: String, val properties: JsonObject = JsonObject(emptyMap()))
