package app.vibefusion.core.network

import app.vibefusion.core.model.ApiError
import app.vibefusion.core.model.ShelfItems
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class ApiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var tokens: InMemoryTokenStore
    private lateinit var api: VibeFusionApi
    private var expired = false
    private val user = """{"id":"u1","email":"a@b.c","displayName":"A","locale":"en-CA","territory":"CA","isGuest":false,"isAdmin":false}"""

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
        tokens = InMemoryTokenStore("old", "r1")
        val base = server.url("/").toString()
        api = NetworkFactory.api(base, NetworkFactory.okHttp(tokens, base, { "CA" }, { expired = true }, debug = false))
    }

    @After fun tearDown() = server.shutdown()

    @Test fun mapsErrorEnvelope() = runTest {
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":{"code":"ASSET_NOT_AVAILABLE","message":"Not in your region.","requestId":"abc","retryable":false}}"""))
        try {
            apiCall { api.authorize(AuthorizeBody("x")) }
            fail()
        } catch (e: ApiError) {
            assertEquals("ASSET_NOT_AVAILABLE", e.code)
            assertEquals(403, e.status)
            assertEquals("abc", e.requestId)
        }
        val sent = server.takeRequest()
        assertEquals("Bearer old", sent.getHeader("Authorization"))
        assertEquals("CA", sent.getHeader("X-Territory"))
    }

    @Test fun refreshesOnceOn401AndRetries() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"TOKEN_EXPIRED","message":"expired","requestId":"r","retryable":false}}"""))
        server.enqueue(MockResponse().setBody("""{"accessToken":"new","refreshToken":"r2","expiresIn":3600,"user":$user}"""))
        server.enqueue(MockResponse().setBody(user))
        val me = apiCall { api.me() }
        assertEquals("u1", me.id)
        assertEquals("new", tokens.accessToken)
        server.takeRequest(); assertEquals("/v1/auth/refresh", server.takeRequest().path)
        assertEquals("Bearer new", server.takeRequest().getHeader("Authorization"))
    }

    @Test fun failedRefreshSignalsExpiry() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        try { apiCall { api.me() }; fail() } catch (e: ApiError) { assertEquals(401, e.status) }
        assertTrue(expired)
    }

    @Test fun decodesHomeShelves() = runTest {
        val asset = """{"id":"a1","title":"Pad","assetType":"loop","durationMs":32000,"capabilities":{"stream":true,"download":true,"mix":true,"render":true}}"""
        server.enqueue(MockResponse().setBody("""{"greeting":"Hi","shelves":[
            {"id":"p","title":"P","kind":"assets","items":[$asset]},{"id":"g","title":"G","kind":"topics","items":[{"id":"ambient","name":"ambient"}]},
            {"id":"s","title":"S","kind":"shows","items":[{"id":"s1","title":"Show"}]},{"id":"m","title":"M","kind":"mixes","items":[{"id":"m1","name":"Mix","durationMs":1}]}]}"""))
        val shelves = apiCall { api.home() }.decoded()
        assertTrue((shelves[0].items as ShelfItems.Assets).items[0].capabilities.mix)
        assertTrue(shelves[1].items is ShelfItems.Topics && shelves[2].items is ShelfItems.Shows && shelves[3].items is ShelfItems.Mixes)
    }

    @Test fun offlineMapsToNetworkError() = runTest {
        server.shutdown()
        try { apiCall { api.motivationTopics() }; fail() } catch (e: ApiError) { assertTrue(e.isOffline) }
    }
}
