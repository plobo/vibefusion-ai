package app.vibefusion.fusion

import android.content.Context
import android.os.Environment
import app.vibefusion.core.audio.FusionEngine
import app.vibefusion.core.model.ApiError
import app.vibefusion.core.model.MediaGrant
import app.vibefusion.core.model.MixPlan
import app.vibefusion.core.model.PlanAuthorization
import app.vibefusion.core.model.RenderAuthorization
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/** App-wide owner of the fusion engine: media buffering, preview lifecycle, and on-device export. */
@Singleton
class FusionController @Inject constructor(@ApplicationContext private val context: Context, val engine: FusionEngine) {
    private val _active = MutableStateFlow(false)
    /** True while a fusion session owns the media session (notification, lock screen, headset buttons). */
    val active = _active.asStateFlow()
    val state = engine.state
    private val media = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build() // no API credentials
    private val cacheDir get() = File(context.cacheDir, "fusion-buffers").apply { mkdirs() }
    private var preparedSignature: String? = null

    init { engine.onBecameActive = { _active.value = true } }

    fun signature(plan: MixPlan) = plan.layers.map { "${it.id}:${it.assetId}" }.sorted().joinToString(",")
    fun isPreparedFor(plan: MixPlan) = engine.plan != null && preparedSignature == signature(plan)

    private suspend fun localFile(grant: MediaGrant): File = withContext(Dispatchers.IO) {
        val ext = if (grant.mimeType.contains("wav")) "wav" else "mp3"
        val f = File(cacheDir, "${grant.assetId}.$ext")
        if (f.exists() && f.length() > 0) return@withContext f
        // Resumable: large open-licence originals can drop mid-transfer, so continue from the partial file with Range.
        val tmp = File(cacheDir, "${grant.assetId}.part")
        var lastError: Exception? = null
        repeat(4) { attempt ->
            try {
                val have = if (tmp.exists()) tmp.length() else 0L
                val req = Request.Builder().url(grant.url).apply { if (have > 0) header("Range", "bytes=$have-") }.build()
                media.newCall(req).execute().use { res ->
                    if (res.code == 416) { tmp.renameTo(f); return@withContext f } // already complete
                    if (!res.isSuccessful) throw ApiError("MEDIA_UNAVAILABLE", "A layer's audio couldn't be loaded (${res.code}).", res.code, res.code >= 500)
                    val append = have > 0 && res.code == 206
                    java.io.FileOutputStream(tmp, append).use { out -> res.body!!.byteStream().copyTo(out) }
                }
                if (tmp.renameTo(f)) return@withContext f
            } catch (e: ApiError) {
                if (!e.retryable) throw e
                lastError = e
            } catch (e: java.io.IOException) {
                android.util.Log.w("VibeFusion", "layer download attempt ${attempt + 1} failed for ${grant.assetId}", e)
                lastError = e
            }
            kotlinx.coroutines.delay(1000L shl attempt)
        }
        throw ApiError("MEDIA_UNAVAILABLE", "A layer's audio couldn't be downloaded (${lastError?.javaClass?.simpleName}). Check your connection and try again.", 0, true)
    }

    suspend fun prepare(auth: PlanAuthorization, onProgress: (Double) -> Unit = {}) {
        val files = HashMap<String, File>()
        val grants = auth.media.values.toList()
        grants.forEachIndexed { i, g -> files[g.assetId] = localFile(g); onProgress((i + 1).toDouble() / grants.size) }
        withContext(Dispatchers.Default) { engine.prepare(auth.plan, files) }
        preparedSignature = signature(auth.plan)
    }

    fun play() = engine.play()
    fun pause() = engine.pause()
    fun toggle() = engine.toggle()
    fun seek(ms: Double) = engine.seek(ms)
    fun update(plan: MixPlan) = engine.update(plan)

    fun deactivateForStandardPlayback() {
        if (engine.state.value.phase == FusionEngine.Phase.PLAYING) engine.pause()
        _active.value = false
    }

    fun stop() { engine.release(); preparedSignature = null; _active.value = false }

    /** Renders to app-specific Music/Exports (no storage permission needed); writes attribution alongside. */
    suspend fun export(auth: RenderAuthorization, name: String, onProgress: (Double) -> Unit): File = withContext(Dispatchers.Default) {
        val files = auth.media.associate { it.assetId to localFile(it) }
        val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_MUSIC) ?: context.filesDir, "Exports").apply { mkdirs() }
        val safe = name.replace(Regex("[^A-Za-z0-9 _-]"), "").ifBlank { "Fusion" }
        val out = File(dir, "$safe.wav")
        FusionEngine.renderOffline(auth.plan, files, out, onProgress)
        auth.attribution?.let { File(dir, "$safe.attribution.txt").writeText(it) }
        out
    }
}
