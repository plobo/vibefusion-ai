import XCTest
@testable import VFCore

/// URLProtocol stub: queue of (status, body) responses per path.
final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var routes: [String: [(Int, String)]] = [:]
    nonisolated(unsafe) static var seen: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.seen.append(request)
        let path = request.url!.path
        var queue = Self.routes[path] ?? [(404, #"{"error":{"code":"NOT_FOUND","message":"nope","requestId":"r","retryable":false}}"#)]
        let (status, body) = queue.count > 1 ? queue.removeFirst() : queue[0]
        Self.routes[path] = queue
        let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class APIClientTests: XCTestCase {
    var api: VibeFusionAPI!
    var tokens: InMemoryTokenStore!

    override func setUp() {
        StubProtocol.routes = [:]
        StubProtocol.seen = []
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubProtocol.self]
        tokens = InMemoryTokenStore(access: "old", refresh: "r1")
        api = VibeFusionAPI(client: APIClient(baseURL: URL(string: "http://test.local")!, tokens: tokens, session: URLSession(configuration: cfg)))
    }

    static let userJSON = #"{"id":"u1","email":"a@b.c","displayName":"A","locale":"en-CA","territory":"CA","isGuest":false,"isAdmin":false}"#

    func testMapsErrorEnvelope() async {
        StubProtocol.routes["/v1/playback/authorize"] = [(403, #"{"error":{"code":"ASSET_NOT_AVAILABLE","message":"This audio is not available in your region.","requestId":"abc","retryable":false}}"#)]
        do {
            _ = try await api.authorize(assetId: "x", context: "stream")
            XCTFail("expected error")
        } catch let e as APIError {
            XCTAssertEqual(e.code, "ASSET_NOT_AVAILABLE")
            XCTAssertEqual(e.status, 403)
            XCTAssertEqual(e.requestId, "abc")
            XCTAssertFalse(e.retryable)
        } catch { XCTFail("\(error)") }
    }

    func testRefreshesExpiredTokenOnceAndRetries() async throws {
        StubProtocol.routes["/v1/me"] = [
            (401, #"{"error":{"code":"TOKEN_EXPIRED","message":"expired","requestId":"r","retryable":false}}"#),
            (200, Self.userJSON),
        ]
        StubProtocol.routes["/v1/auth/refresh"] = [(200, #"{"accessToken":"new","refreshToken":"r2","expiresIn":3600,"user":\#(Self.userJSON)}"#)]
        let me = try await api.me()
        XCTAssertEqual(me.user.id, "u1")
        XCTAssertEqual(tokens.accessToken, "new")
        XCTAssertEqual(tokens.refreshToken, "r2")
        XCTAssertEqual(StubProtocol.seen.last?.value(forHTTPHeaderField: "Authorization"), "Bearer new")
    }

    func testDecodesHomeShelvesOfEachKind() async throws {
        let asset = #"{"id":"a1","title":"Pad","assetType":"loop","durationMs":32000,"streamingFormat":"progressive","language":"en","genres":["ambient"],"moods":[],"topics":[],"isExplicit":false,"isActive":true,"capabilities":{"stream":true,"download":true,"mix":true,"render":true}}"#
        StubProtocol.routes["/v1/home"] = [(200, """
        {"greeting":"Hi","shelves":[
          {"id":"popular","title":"Popular","kind":"assets","items":[\(asset)]},
          {"id":"genres","title":"Genres","kind":"topics","items":[{"id":"ambient","name":"ambient"}]},
          {"id":"podcasts","title":"Pods","kind":"shows","items":[{"id":"s1","title":"Show"}]},
          {"id":"mixes","title":"Mixes","kind":"mixes","items":[{"id":"m1","name":"Mix","durationMs":1000}]}]}
        """)]
        let home = try await api.home()
        XCTAssertEqual(home.shelves.count, 4)
        guard case .assets(let a) = home.shelves[0].items else { return XCTFail() }
        XCTAssertTrue(a[0].capabilities.mix)
        guard case .topics = home.shelves[1].items, case .shows = home.shelves[2].items, case .mixes = home.shelves[3].items else { return XCTFail() }
    }

    func testOfflineMapsToNetworkError() async {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 1
        let offline = VibeFusionAPI(client: APIClient(baseURL: URL(string: "http://127.0.0.1:1")!, tokens: tokens, session: URLSession(configuration: cfg)))
        do { _ = try await offline.motivationTopics(); XCTFail() } catch let e as APIError { XCTAssertTrue(e.isOffline) } catch { XCTFail("\(error)") }
    }

    @MainActor
    func testOptimisticLikeRollsBackOnFailure() async {
        StubProtocol.routes["/v1/library/likes/a1"] = [(500, #"{"error":{"code":"INTERNAL","message":"boom","requestId":"r","retryable":false}}"#)]
        let cacheDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = LibraryStore(api: api, cache: ResponseCache(directory: cacheDir))
        let asset = Asset(id: "a1", title: "T", assetType: .music, durationMs: 1000)
        let result = await store.toggleLike(asset)
        XCTAssertFalse(result)
        XCTAssertFalse(store.isLiked("a1"))
        XCTAssertEqual(store.lastError?.code, "INTERNAL")
        StubProtocol.routes["/v1/library/likes/a1"] = [(204, "")]
        let ok = await store.toggleLike(asset)
        XCTAssertTrue(ok)
        XCTAssertTrue(store.isLiked("a1"))
    }

    func testAnalyticsEventsEncodeAllowListedShape() throws {
        let e = AnalyticsEvent(name: "playback_started", properties: ["assetId": "a1", "latencyMs": 250])
        let json = String(data: try JSONEncoder().encode(e), encoding: .utf8)!
        XCTAssertTrue(json.contains(#""latencyMs":250"#))
        XCTAssertTrue(json.contains("playback_started"))
    }
}
