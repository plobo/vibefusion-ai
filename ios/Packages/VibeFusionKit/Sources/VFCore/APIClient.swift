import Foundation
import OSLog

public let vfLog = Logger(subsystem: "app.vibefusion", category: "core")

/// Error surfaced to UI; mirrors the server error envelope.
public struct APIError: Error, LocalizedError, Equatable, Sendable {
    public var code: String
    public var message: String
    public var status: Int
    public var retryable: Bool
    public var requestId: String?
    public var details: [String: AnyCodable]?
    public var errorDescription: String? { message }

    public init(code: String, message: String, status: Int, retryable: Bool, requestId: String? = nil, details: [String: AnyCodable]? = nil) {
        self.code = code; self.message = message; self.status = status; self.retryable = retryable; self.requestId = requestId; self.details = details
    }

    public static func network(_ msg: String) -> APIError {
        APIError(code: "NETWORK", message: msg, status: 0, retryable: true)
    }
    public static let decoding = APIError(code: "DECODING", message: "The server sent something unexpected.", status: 0, retryable: false)
    public var isOffline: Bool { code == "NETWORK" }
}

struct ErrorEnvelope: Decodable {
    struct Body: Decodable { var code: String; var message: String; var requestId: String?; var retryable: Bool?; var details: [String: AnyCodable]? }
    var error: Body
}

/// Minimal type-erased JSON value for error details.
public struct AnyCodable: Codable, Equatable, Sendable {
    public let raw: String
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { raw = s }
        else if let n = try? c.decode(Double.self) { raw = String(n) }
        else if let b = try? c.decode(Bool.self) { raw = String(b) }
        else { raw = "" }
    }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(raw) }
}

/// Bearer-token session storage (Keychain-backed in the app; in-memory in tests).
public protocol TokenStore: AnyObject, Sendable {
    var accessToken: String? { get }
    var refreshToken: String? { get }
    func save(access: String, refresh: String)
    func clear()
}

public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var a: String?
    private var r: String?
    public init(access: String? = nil, refresh: String? = nil) { a = access; r = refresh }
    public var accessToken: String? { lock.withLock { a } }
    public var refreshToken: String? { lock.withLock { r } }
    public func save(access: String, refresh: String) { lock.withLock { a = access; r = refresh } }
    public func clear() { lock.withLock { a = nil; r = nil } }
}

public enum HTTPMethod: String, Sendable { case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE" }

/// Typed HTTP client: JSON, bearer auth with single-flight refresh, retries with exponential backoff for idempotent calls.
public final class APIClient: @unchecked Sendable {
    public var baseURL: URL
    public let tokens: TokenStore
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder = JSONEncoder()
    private let refreshLock = NSLock()
    private var refreshTask: Task<Bool, Never>?
    public var territory: String? = nil
    public var onSessionExpired: (@Sendable () -> Void)?

    public init(baseURL: URL, tokens: TokenStore, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.tokens = tokens
        self.session = session
        self.decoder = JSONDecoder()
    }

    public func request<T: Decodable>(_ method: HTTPMethod, _ path: String, query: [String: String?] = [:], body: (any Encodable)? = nil,
                                      headers: [String: String] = [:], retries: Int? = nil) async throws -> T {
        let data = try await raw(method, path, query: query, body: body, headers: headers, retries: retries)
        if T.self == Empty.self { return Empty() as! T }
        do { return try decoder.decode(T.self, from: data) } catch {
            vfLog.error("decode \(path, privacy: .public): \(String(describing: error), privacy: .public)")
            throw APIError.decoding
        }
    }

    public func send(_ method: HTTPMethod, _ path: String, body: (any Encodable)? = nil, headers: [String: String] = [:]) async throws {
        _ = try await raw(method, path, body: body, headers: headers)
    }

    func raw(_ method: HTTPMethod, _ path: String, query: [String: String?] = [:], body: (any Encodable)? = nil,
             headers: [String: String] = [:], retries: Int? = nil, didRefresh: Bool = false) async throws -> Data {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        let q = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }
        if !q.isEmpty { comps.queryItems = q.sorted { $0.name < $1.name } }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method.rawValue
        req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let t = tokens.accessToken { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        if let territory { req.setValue(territory, forHTTPHeaderField: "X-Territory") }
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if let body {
            req.httpBody = try encoder.encode(AnyEncodable(body))
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let maxAttempts = 1 + (retries ?? (method == .get ? 2 : 0))
        var attempt = 0
        while true {
            attempt += 1
            do {
                let (data, resp) = try await session.data(for: req)
                let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(status) { return data }
                let env = try? decoder.decode(ErrorEnvelope.self, from: data)
                let err = APIError(code: env?.error.code ?? "HTTP_\(status)", message: env?.error.message ?? HTTPURLResponse.localizedString(forStatusCode: status),
                                   status: status, retryable: env?.error.retryable ?? (status >= 500), requestId: env?.error.requestId, details: env?.error.details)
                if status == 401 && !didRefresh && tokens.refreshToken != nil && !path.hasPrefix("/v1/auth/") {
                    if await refreshSession() {
                        return try await raw(method, path, query: query, body: body, headers: headers, retries: retries, didRefresh: true)
                    }
                    onSessionExpired?()
                }
                if err.retryable && attempt < maxAttempts && status != 429 {
                    try await backoff(attempt); continue
                }
                throw err
            } catch let e as APIError {
                throw e
            } catch is CancellationError {
                throw CancellationError()
            } catch let e as URLError where e.code == .cancelled {
                throw CancellationError()
            } catch {
                if attempt < maxAttempts { try await backoff(attempt); continue }
                throw APIError.network("You appear to be offline. Check your connection and try again.")
            }
        }
    }

    private func backoff(_ attempt: Int) async throws {
        let base = 0.4 * pow(2, Double(attempt - 1))
        try await Task.sleep(nanoseconds: UInt64((base + Double.random(in: 0...0.2)) * 1_000_000_000))
    }

    /// Single-flight refresh shared by concurrent 401s.
    public func refreshSession() async -> Bool {
        let task: Task<Bool, Never> = refreshLock.withLock {
            if let t = refreshTask { return t }
            let t = Task<Bool, Never> { [weak self] in
                guard let self, let rt = self.tokens.refreshToken else { return false }
                do {
                    let data = try await self.raw(.post, "/v1/auth/refresh", body: ["refreshToken": rt], didRefresh: true)
                    let tokens = try self.decoder.decode(Tokens.self, from: data)
                    self.tokens.save(access: tokens.accessToken, refresh: tokens.refreshToken)
                    return true
                } catch {
                    return false
                }
            }
            refreshTask = t
            return t
        }
        let ok = await task.value
        refreshLock.withLock { refreshTask = nil }
        return ok
    }
}

public struct Empty: Codable, Sendable { public init() {} }

struct AnyEncodable: Encodable {
    let value: any Encodable
    init(_ v: any Encodable) { value = v }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
