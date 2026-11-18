package app.vibefusion.core.network

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.vibefusion.core.model.ApiError
import app.vibefusion.core.model.Tokens
import app.vibefusion.core.model.VfJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Route
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.io.IOException
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Session token storage port. */
interface TokenStore {
    val accessToken: String?
    val refreshToken: String?
    fun save(access: String, refresh: String)
    fun clear()
}

class InMemoryTokenStore(private var a: String? = null, private var r: String? = null) : TokenStore {
    override val accessToken get() = a
    override val refreshToken get() = r
    @Synchronized override fun save(access: String, refresh: String) { a = access; r = refresh }
    @Synchronized override fun clear() { a = null; r = null }
}

/** Tokens encrypted with an AES-GCM key held in the Android Keystore (never exported, never in backups). */
class KeystoreTokenStore(context: Context) : TokenStore {
    private val prefs = context.getSharedPreferences("vf.session", Context.MODE_PRIVATE)
    private val alias = "vf.session.key"
    @Volatile private var cache: Pair<String?, String?>? = null

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun encrypt(v: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val out = c.iv + c.doFinal(v.toByteArray())
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    private fun decrypt(v: String?): String? = try {
        v?.let {
            val raw = Base64.decode(it, Base64.NO_WRAP)
            val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12)) }
            String(c.doFinal(raw, 12, raw.size - 12))
        }
    } catch (_: Exception) { null }

    private fun load(): Pair<String?, String?> = cache ?: (decrypt(prefs.getString("a", null)) to decrypt(prefs.getString("r", null))).also { cache = it }
    override val accessToken get() = load().first
    override val refreshToken get() = load().second
    @Synchronized override fun save(access: String, refresh: String) {
        prefs.edit().putString("a", encrypt(access)).putString("r", encrypt(refresh)).apply()
        cache = access to refresh
    }
    @Synchronized override fun clear() { prefs.edit().clear().apply(); cache = null to null }
}

/** Adds bearer token and territory headers. */
class AuthInterceptor(private val tokens: TokenStore, private val territory: () -> String?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val b = chain.request().newBuilder().header("Accept", "application/json")
        tokens.accessToken?.let { b.header("Authorization", "Bearer $it") }
        territory()?.let { b.header("X-Territory", it) }
        return chain.proceed(b.build())
    }
}

/** On 401, refreshes once (single-flight via synchronization) and retries; signals session expiry otherwise. */
class TokenAuthenticator(private val baseUrl: String, private val tokens: TokenStore, private val onExpired: () -> Unit) : Authenticator {
    private val bare = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).build()

    override fun authenticate(route: Route?, response: Response): Request? {
        if (response.request.url.encodedPath.contains("/v1/auth/")) return null
        if (responseCount(response) > 1) return null
        synchronized(this) {
            val sentWith = response.request.header("Authorization")?.removePrefix("Bearer ")
            val current = tokens.accessToken
            if (current != null && current != sentWith) return response.request.withToken(current) // another thread refreshed
            val rt = tokens.refreshToken ?: return null
            val body = VfJson.encodeToString(RefreshBody.serializer(), RefreshBody(rt)).toRequestBody("application/json".toMediaType())
            val res = try { bare.newCall(Request.Builder().url(baseUrl.trimEnd('/') + "/v1/auth/refresh").post(body).build()).execute() } catch (_: IOException) { return null }
            res.use {
                if (!it.isSuccessful) { onExpired(); return null }
                val t = VfJson.decodeFromString(Tokens.serializer(), it.body!!.string())
                tokens.save(t.accessToken, t.refreshToken)
                return response.request.withToken(t.accessToken)
            }
        }
    }

    private fun Request.withToken(t: String) = newBuilder().header("Authorization", "Bearer $t").build()
    private fun responseCount(r: Response): Int { var c = 1; var p = r.priorResponse; while (p != null) { c++; p = p.priorResponse }; return c }
}

object NetworkFactory {
    fun okHttp(tokens: TokenStore, baseUrl: String, territory: () -> String?, onExpired: () -> Unit, debug: Boolean): OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .addInterceptor(AuthInterceptor(tokens, territory))
            .authenticator(TokenAuthenticator(baseUrl, tokens, onExpired))
            .apply { if (debug) addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC; redactHeader("Authorization") }) }
            .build()

    fun api(baseUrl: String, client: OkHttpClient): VibeFusionApi = Retrofit.Builder()
        .baseUrl(baseUrl.trimEnd('/') + "/")
        .client(client)
        .addConverterFactory(VfJson.asConverterFactory("application/json".toMediaType()))
        .build()
        .create(VibeFusionApi::class.java)
}

/** Runs an API call, mapping failures to [ApiError]. Idempotent reads retry with exponential backoff. */
suspend fun <T> apiCall(retries: Int = 0, block: suspend () -> T): T {
    var attempt = 0
    while (true) {
        try {
            return block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: HttpException) {
            val err = ApiError.parse(e.code(), e.response()?.errorBody()?.string())
            if (err.retryable && attempt < retries && e.code() != 429) { delay(400L shl attempt); attempt++; continue }
            throw err
        } catch (e: IOException) {
            if (attempt < retries) { delay(400L shl attempt); attempt++; continue }
            throw ApiError.network()
        }
    }
}

/** For endpoints returning Response<Unit>. */
fun retrofit2.Response<Unit>.orThrow() { if (!isSuccessful) throw ApiError.parse(code(), errorBody()?.string()) }
