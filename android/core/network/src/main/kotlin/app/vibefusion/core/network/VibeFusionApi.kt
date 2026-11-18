package app.vibefusion.core.network

import app.vibefusion.core.model.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.*

@Serializable data class RegisterBody(val email: String, val password: String, val displayName: String? = null, val locale: String? = null)
@Serializable data class LoginBody(val email: String, val password: String)
@Serializable data class RefreshBody(val refreshToken: String)
@Serializable data class AuthorizeBody(val assetId: String, val context: String = "stream", val quality: String? = null)
@Serializable data class ProgressBody(val assetId: String, val positionMs: Int, val durationMs: Int? = null)
@Serializable data class EventsBody(val platform: String = "android", val events: List<AnalyticsEvent>)
@Serializable data class CreatePlaylistBody(val name: String, val assetIds: List<String> = emptyList())
@Serializable data class RenameBody(val name: String)
@Serializable data class AddItemBody(val assetId: String, val version: Int, val position: Int? = null)
@Serializable data class ReorderBody(val itemIds: List<String>, val version: Int)
@Serializable data class BookmarkBody(val positionMs: Int, val note: String? = null)
@Serializable data class ValidateBody(val plan: MixPlan, val requireExport: Boolean = false)
@Serializable data class PlanBody(val plan: MixPlan)
@Serializable data class SaveRecipeBody(val name: String, val prompt: String? = null, val plan: MixPlan, val planner: String = "manual")
@Serializable data class UpdateRecipeBody(val name: String? = null, val plan: MixPlan? = null, val version: Int)
@Serializable data class RenderBody(val recipeId: String)
@Serializable data class CompleteRenderBody(val status: String, val error: String? = null)
@Serializable data class UpgradeBody(val email: String, val password: String)

/** Typed client for contracts/openapi.yaml. */
interface VibeFusionApi {
    @POST("v1/auth/register") suspend fun register(@Body b: RegisterBody): Tokens
    @POST("v1/auth/login") suspend fun login(@Body b: LoginBody): Tokens
    @POST("v1/auth/guest") suspend fun guest(): Tokens
    @POST("v1/auth/upgrade") suspend fun upgrade(@Body b: UpgradeBody): Tokens
    @POST("v1/auth/refresh") suspend fun refresh(@Body b: RefreshBody): Tokens
    @POST("v1/auth/logout") suspend fun logout(@Body b: RefreshBody): Response<Unit>
    @GET("v1/me") suspend fun me(): Me
    @PUT("v1/me/preferences") suspend fun updatePreferences(@Body p: Preferences): Preferences
    @GET("v1/me/export") suspend fun exportData(): ResponseBody
    @DELETE("v1/me") suspend fun deleteAccount(): Response<Unit>

    @GET("v1/home") suspend fun home(): HomeResponse
    @GET("v1/catalogue") suspend fun catalogue(
        @Query("type") type: String? = null, @Query("genre") genre: String? = null, @Query("mood") mood: String? = null,
        @Query("topic") topic: String? = null, @Query("mixable") mixable: Boolean? = null, @Query("cursor") cursor: String? = null,
        @Query("limit") limit: Int = 20,
    ): Page<Asset>
    @GET("v1/assets/{id}") suspend fun asset(@Path("id") id: String): Asset
    @GET("v1/creators/{id}") suspend fun creator(@Path("id") id: String): CreatorDetail
    @GET("v1/genres") suspend fun genres(): Items<app.vibefusion.core.model.Tag>
    @GET("v1/moods") suspend fun moods(): Items<app.vibefusion.core.model.Tag>
    @GET("v1/collections") suspend fun collections(): Items<CatalogueCollection>
    @GET("v1/collections/{id}") suspend fun collection(@Path("id") id: String): CatalogueCollection
    @GET("v1/search") suspend fun search(
        @Query("q") q: String, @Query("content") content: String? = null, @Query("genre") genre: String? = null,
        @Query("mood") mood: String? = null, @Query("maxDurationMs") maxDurationMs: Int? = null, @Query("language") language: String? = null,
    ): SearchResults

    @POST("v1/playback/authorize") suspend fun authorize(@Body b: AuthorizeBody): PlaybackAuthorization
    @POST("v1/playback/progress") suspend fun saveProgress(@Body b: ProgressBody): Response<Unit>
    @GET("v1/playback/progress/{id}") suspend fun progress(@Path("id") id: String): ProgressResponse
    @GET("v1/playback/recent") suspend fun recent(): Items<RecentItem>
    @POST("v1/playback/events") suspend fun events(@Body b: EventsBody): Response<Unit>

    @GET("v1/library") suspend fun library(): LibrarySnapshot
    @PUT("v1/library/likes/{id}") suspend fun like(@Path("id") id: String): Response<Unit>
    @DELETE("v1/library/likes/{id}") suspend fun unlike(@Path("id") id: String): Response<Unit>
    @PUT("v1/podcasts/{id}/follow") suspend fun follow(@Path("id") id: String): Response<Unit>
    @DELETE("v1/podcasts/{id}/follow") suspend fun unfollow(@Path("id") id: String): Response<Unit>
    @GET("v1/playlists") suspend fun playlists(): Items<PlaylistSummary>
    @POST("v1/playlists") suspend fun createPlaylist(@Body b: CreatePlaylistBody, @Header("Idempotency-Key") key: String): Playlist
    @GET("v1/playlists/{id}") suspend fun playlist(@Path("id") id: String): Playlist
    @PATCH("v1/playlists/{id}") suspend fun renamePlaylist(@Path("id") id: String, @Body b: RenameBody, @Header("If-Match") version: String): Playlist
    @DELETE("v1/playlists/{id}") suspend fun deletePlaylist(@Path("id") id: String): Response<Unit>
    @POST("v1/playlists/{id}/items") suspend fun addItem(@Path("id") id: String, @Body b: AddItemBody): Playlist
    @PATCH("v1/playlists/{id}/items/reorder") suspend fun reorder(@Path("id") id: String, @Body b: ReorderBody): Playlist
    @DELETE("v1/playlists/{id}/items/{itemId}") suspend fun removeItem(@Path("id") id: String, @Path("itemId") itemId: String, @Query("version") version: Int): Playlist

    @GET("v1/podcasts") suspend fun podcasts(@Query("category") category: String? = null): Items<Show>
    @GET("v1/podcasts/{id}") suspend fun show(@Path("id") id: String): Show
    @GET("v1/podcasts/{id}/episodes") suspend fun episodes(@Path("id") id: String, @Query("cursor") cursor: String? = null): Page<Asset>
    @GET("v1/episodes/{id}") suspend fun episode(@Path("id") id: String): EpisodeDetail
    @GET("v1/assets/{id}/transcript") suspend fun transcript(@Path("id") id: String): Transcript
    @POST("v1/assets/{id}/bookmarks") suspend fun addBookmark(@Path("id") id: String, @Body b: BookmarkBody): Bookmark
    @DELETE("v1/bookmarks/{id}") suspend fun deleteBookmark(@Path("id") id: String): Response<Unit>
    @GET("v1/motivation/topics") suspend fun motivationTopics(): Items<app.vibefusion.core.model.Tag>
    @GET("v1/motivation/featured") suspend fun motivationFeatured(@Query("topic") topic: String? = null): MotivationFeatured

    @GET("v1/fusion/status") suspend fun fusionStatus(): FusionStatus
    @POST("v1/fusion/plan") suspend fun plan(@Body b: FusionRequest): FusionPlanResponse
    @POST("v1/fusion/validate") suspend fun validate(@Body b: ValidateBody): ValidateResponse
    @GET("v1/fusion/recipes") suspend fun recipes(): Items<MixRecipe>
    @GET("v1/fusion/recipes/{id}") suspend fun recipe(@Path("id") id: String): MixRecipe
    @POST("v1/fusion/recipes") suspend fun saveRecipe(@Body b: SaveRecipeBody, @Header("Idempotency-Key") key: String): MixRecipe
    @PATCH("v1/fusion/recipes/{id}") suspend fun updateRecipe(@Path("id") id: String, @Body b: UpdateRecipeBody): MixRecipe
    @DELETE("v1/fusion/recipes/{id}") suspend fun deleteRecipe(@Path("id") id: String): Response<Unit>
    @POST("v1/fusion/recipes/{id}/playback-authorize") suspend fun authorizeRecipe(@Path("id") id: String, @Body b: JsonObject = JsonObject(emptyMap())): PlanAuthorization
    @POST("v1/fusion/preview-authorize") suspend fun authorizePreview(@Body b: PlanBody): PlanAuthorization
    @POST("v1/fusion/render") suspend fun render(@Body b: RenderBody, @Header("Idempotency-Key") key: String): RenderAuthorization
    @POST("v1/fusion/render-jobs/{id}/complete") suspend fun completeRender(@Path("id") id: String, @Body b: CompleteRenderBody): Response<Unit>
    @POST("v1/fusion/recipes/{id}/share") suspend fun share(@Path("id") id: String, @Body b: JsonObject = JsonObject(emptyMap())): ShareResponse
}
