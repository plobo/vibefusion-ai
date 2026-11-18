package app.vibefusion.di

import android.content.Context
import app.vibefusion.BuildConfig
import app.vibefusion.core.audio.FusionEngine
import app.vibefusion.core.database.VfDatabase
import app.vibefusion.core.network.KeystoreTokenStore
import app.vibefusion.core.network.NetworkFactory
import app.vibefusion.core.network.TokenStore
import app.vibefusion.core.network.VibeFusionApi
import app.vibefusion.data.SessionSignals
import app.vibefusion.data.Settings
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Dispatchers
import okhttp3.OkHttpClient
import javax.inject.Named
import javax.inject.Singleton

/** Composition root. AI, storage, auth, streaming and analytics are all behind injectable seams. */
@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides @Singleton fun tokenStore(@ApplicationContext c: Context): TokenStore = KeystoreTokenStore(c)

    @Provides @Singleton @Named("baseUrl")
    fun baseUrl(settings: Settings): String = settings.serverUrlBlocking() ?: BuildConfig.API_BASE_URL

    @Provides @Singleton
    fun okHttp(tokens: TokenStore, @Named("baseUrl") baseUrl: String, signals: SessionSignals): OkHttpClient =
        NetworkFactory.okHttp(tokens, baseUrl, { signals.territory }, { signals.expired() }, BuildConfig.DEBUG)

    @Provides @Singleton fun api(@Named("baseUrl") baseUrl: String, client: OkHttpClient): VibeFusionApi = NetworkFactory.api(baseUrl, client)

    @Provides @Singleton fun database(@ApplicationContext c: Context): VfDatabase = VfDatabase.create(c)

    @Provides @Singleton fun fusionEngine(@ApplicationContext c: Context): FusionEngine = FusionEngine(c)

    @Provides @Singleton @Named("appScope") fun appScope(): CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
}
