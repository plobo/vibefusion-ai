package app.vibefusion.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.vibefusion.core.database.CachedJsonEntity
import app.vibefusion.core.database.DownloadEntity
import app.vibefusion.core.database.LikeEntity
import app.vibefusion.core.database.PendingProgressEntity
import app.vibefusion.core.database.VfDatabase
import app.vibefusion.core.model.*
import app.vibefusion.core.network.*
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

private val Context.dataStore by preferencesDataStore("vf.settings")

/** Non-sensitive app settings (DataStore). */
@Singleton
class Settings @Inject constructor(@ApplicationContext private val context: Context) {
    private val ONBOARDED = booleanPreferencesKey("onboarded")
    private val QUALITY = stringPreferencesKey("quality")
    private val DATA_SAVER = booleanPreferencesKey("dataSaver")
    private val WIFI_ONLY = booleanPreferencesKey("wifiOnly")
    private val SERVER = stringPreferencesKey("serverUrl")
    val onboarded = context.dataStore.data.map { it[ONBOARDED] ?: false }
    val quality = context.dataStore.data.map { it[QUALITY] ?: "auto" }
    val dataSaver = context.dataStore.data.map { it[DATA_SAVER] ?: false }
    val wifiOnly = context.dataStore.data.map { it[WIFI_ONLY] ?: true }
    val serverUrl = context.dataStore.data.map { it[SERVER] }
    suspend fun setOnboarded(v: Boolean) = context.dataStore.edit { it[ONBOARDED] = v }
    suspend fun setQuality(v: String) = context.dataStore.edit { it[QUALITY] = v }
    suspend fun setDataSaver(v: Boolean) = context.dataStore.edit { it[DATA_SAVER] = v }
    suspend fun setWifiOnly(v: Boolean) = context.dataStore.edit { it[WIFI_ONLY] = v }
    suspend fun setServerUrl(v: String?) = context.dataStore.edit { if (v.isNullOrBlank()) it.remove(SERVER) else it[SERVER] = v }
    fun serverUrlBlocking(): String? = runBlocking { serverUrl.first() }?.takeIf { it.isNotBlank() }
}

/** Cross-layer session signals (territory header, expiry callback) without a DI cycle. */
@Singleton
class SessionSignals @Inject constructor() {
    @Volatile var territory: String? = null
    val expiredEvents = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    fun expired() { expiredEvents.tryEmit(Unit) }
}

enum class SessionState { UNKNOWN, SIGNED_OUT, GUEST, ACCOUNT }

@Singleton
class SessionRepository @Inject constructor(
    private val api: VibeFusionApi,
    private val tokens: TokenStore,
    private val signals: SessionSignals,
    private val db: VfDatabase,
    @Named("appScope") private val scope: CoroutineScope,
) {
    val state = MutableStateFlow(SessionState.UNKNOWN)
    val user = MutableStateFlow<User?>(null)
    val preferences = MutableStateFlow(Preferences())

    init { scope.launch { signals.expiredEvents.collect { state.value = SessionState.SIGNED_OUT } } }

    suspend fun bootstrap() {
        if (tokens.refreshToken == null) { state.value = SessionState.SIGNED_OUT; return }
        try {
            val me = apiCall(retries = 1) { api.me() }
            apply(me.user(), me.preferences)
        } catch (e: ApiError) {
            state.value = if (e.isOffline) SessionState.ACCOUNT else SessionState.SIGNED_OUT
        }
    }

    private fun apply(u: User, prefs: Preferences? = null) {
        user.value = u
        prefs?.let { preferences.value = it }
        signals.territory = u.territory
        state.value = if (u.isGuest) SessionState.GUEST else SessionState.ACCOUNT
    }

    private suspend fun signedIn(t: Tokens) {
        tokens.save(t.accessToken, t.refreshToken)
        apply(t.user)
        runCatching { apiCall { api.me() } }.getOrNull()?.let { apply(it.user(), it.preferences) }
    }

    suspend fun register(email: String, password: String, name: String?) = signedIn(apiCall { api.register(RegisterBody(email, password, name, java.util.Locale.getDefault().toLanguageTag())) })
    suspend fun login(email: String, password: String) = signedIn(apiCall { api.login(LoginBody(email, password)) })
    suspend fun guest() = signedIn(apiCall { api.guest() })
    suspend fun upgrade(email: String, password: String) = signedIn(apiCall { api.upgrade(UpgradeBody(email, password)) })

    suspend fun savePreferences(p: Preferences) {
        preferences.value = p
        runCatching { apiCall { api.updatePreferences(p) } }.getOrNull()?.let { preferences.value = it }
    }

    suspend fun signOut() {
        runCatching { api.logout(RefreshBody(tokens.refreshToken ?: "")) }
        tokens.clear()
        withContext(Dispatchers.IO) { db.cache().clear(); db.likes().clear() }
        user.value = null
        state.value = SessionState.SIGNED_OUT
    }

    suspend fun deleteAccount() { apiCall { api.deleteAccount() }.orThrow(); signOut() }
}

/** Server-authoritative library with optimistic likes (rolled back on failure) and an offline cache. */
@Singleton
class LibraryRepository @Inject constructor(private val api: VibeFusionApi, private val db: VfDatabase) {
    val likedIds: Flow<Set<String>> = db.likes().observeIds().map { it.toSet() }
    val snapshot = MutableStateFlow<LibrarySnapshot?>(null)
    val lastError = MutableStateFlow<ApiError?>(null)
    private val pending = Mutex()

    suspend fun refresh() {
        try {
            val s = apiCall(retries = 1) { api.library() }
            snapshot.value = s
            db.cache().put(CachedJsonEntity("library", VfJson.encodeToString(LibrarySnapshot.serializer(), s)))
            db.likes().clear()
            db.likes().addAll((s.likedMusic + s.savedEpisodes).map { LikeEntity(it.id) })
            lastError.value = null
        } catch (e: ApiError) {
            lastError.value = e
            if (snapshot.value == null) db.cache().get("library")?.let { snapshot.value = VfJson.decodeFromString(LibrarySnapshot.serializer(), it.json) }
        }
    }

    /** Optimistic toggle; returns the resulting liked state. */
    suspend fun toggleLike(asset: Asset, currentlyLiked: Boolean): Boolean = pending.withLock {
        if (currentlyLiked) db.likes().remove(asset.id) else db.likes().add(LikeEntity(asset.id))
        try {
            apiCall { if (currentlyLiked) api.unlike(asset.id) else api.like(asset.id) }.orThrow()
            !currentlyLiked
        } catch (e: ApiError) {
            if (currentlyLiked) db.likes().add(LikeEntity(asset.id)) else db.likes().remove(asset.id)
            lastError.value = e
            currentlyLiked
        }
    }
}

/** Licence-gated downloads into app-private storage. */
@Singleton
class DownloadRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    private val api: VibeFusionApi,
    private val db: VfDatabase,
    private val client: OkHttpClient,
) {
    val downloads = db.downloads().observeAll()
    val inFlight = MutableStateFlow<Set<String>>(emptySet())
    private val dir get() = File(context.filesDir, "downloads").apply { mkdirs() }

    suspend fun localFile(assetId: String): File? = db.downloads().get(assetId)?.let { File(it.filePath) }?.takeIf { it.exists() }

    suspend fun download(asset: Asset): Result<Unit> = withContext(Dispatchers.IO) {
        if (!asset.capabilities.download) return@withContext Result.failure(ApiError("RIGHTS_NOT_GRANTED", "Downloads aren't permitted for this audio.", 403, false))
        inFlight.update { it + asset.id }
        try {
            val grant = apiCall { api.authorize(AuthorizeBody(asset.id, "offline_download")) }
            val ext = if (grant.mimeType.contains("wav")) "wav" else "mp3"
            val file = File(dir, "${asset.id}.$ext")
            client.newCall(Request.Builder().url(grant.url).build()).execute().use { res ->
                if (!res.isSuccessful) throw ApiError("DOWNLOAD_FAILED", "Download failed (${res.code}).", res.code, true)
                file.outputStream().use { out -> res.body!!.byteStream().copyTo(out) }
            }
            db.downloads().upsert(DownloadEntity(asset.id, asset.title, asset.creatorName, asset.artworkUrl, asset.assetType, asset.durationMs, file.absolutePath, grant.mimeType))
            Result.success(Unit)
        } catch (e: ApiError) { Result.failure(e) } catch (e: Exception) { Result.failure(ApiError.network()) } finally { inFlight.update { it - asset.id } }
    }

    suspend fun remove(assetId: String) = withContext(Dispatchers.IO) { localFile(assetId)?.delete(); db.downloads().delete(assetId) }
    suspend fun removeAll() = withContext(Dispatchers.IO) { db.downloads().all().forEach { remove(it.assetId) } }
}

/** Playback progress with an offline outbox. */
@Singleton
class ProgressRepository @Inject constructor(private val api: VibeFusionApi, private val db: VfDatabase) {
    suspend fun save(assetId: String, positionMs: Int, durationMs: Int) {
        try { apiCall { api.saveProgress(ProgressBody(assetId, positionMs.coerceAtLeast(0), durationMs)) }.orThrow() }
        catch (_: ApiError) { db.progress().upsert(PendingProgressEntity(assetId, positionMs, durationMs)) }
    }
    suspend fun resumePosition(assetId: String): Int = runCatching { apiCall { api.progress(assetId) } }.getOrNull()?.let { if (it.completed) 0 else it.positionMs } ?: 0
    suspend fun flush() {
        for (p in db.progress().all()) {
            if (runCatching { apiCall { api.saveProgress(ProgressBody(p.assetId, p.positionMs, p.durationMs)) }.orThrow() }.isSuccess) db.progress().delete(p.assetId)
        }
    }
}

/** Batched, allow-listed analytics; disabled entirely when the user opts out. */
@Singleton
class Analytics @Inject constructor(private val api: VibeFusionApi, private val session: SessionRepository, @Named("appScope") private val scope: CoroutineScope) {
    private val buffer = mutableListOf<AnalyticsEvent>()
    private val lock = Mutex()

    fun track(name: String, vararg props: Pair<String, Any>) {
        if (!session.preferences.value.analyticsOptIn || session.state.value == SessionState.SIGNED_OUT) return
        val obj = buildJsonObject {
            props.forEach { (k, v) -> when (v) { is Number -> put(k, JsonPrimitive(v)); is Boolean -> put(k, JsonPrimitive(v)); else -> put(k, JsonPrimitive(v.toString())) } }
        }
        scope.launch {
            val flushNow = lock.withLock { buffer += AnalyticsEvent(name, Instant.now().toString(), obj); buffer.size >= 20 }
            if (flushNow) flush()
        }
    }

    suspend fun flush() {
        val batch = lock.withLock { buffer.toList().also { buffer.clear() } }
        if (batch.isEmpty()) return
        runCatching { apiCall { api.events(EventsBody(events = batch)) } }.onFailure { lock.withLock { buffer.addAll(0, batch.takeLast(100)) } }
    }
}

fun newIdempotencyKey() = UUID.randomUUID().toString()
