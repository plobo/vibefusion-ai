import Foundation
import Security

/// Stores session tokens in the Keychain (this-device-only, after first unlock so background playback can refresh).
public final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    private let service: String
    private let lock = NSLock()
    private var cache: (String?, String?)?

    public init(service: String = "app.vibefusion.session") { self.service = service }

    public var accessToken: String? { load().0 }
    public var refreshToken: String? { load().1 }

    public func save(access: String, refresh: String) {
        lock.withLock {
            write("access", access)
            write("refresh", refresh)
            cache = (access, refresh)
        }
    }

    public func clear() {
        lock.withLock {
            for k in ["access", "refresh"] {
                SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: k] as CFDictionary)
            }
            cache = (nil, nil)
        }
    }

    private func load() -> (String?, String?) {
        lock.withLock {
            if let c = cache { return c }
            let c = (read("access"), read("refresh"))
            cache = c
            return c
        }
    }

    private func write(_ account: String, _ value: String) {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData] = Data(value.utf8)
        add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess { vfLog.error("Keychain write failed: \(status)") }
    }

    private func read(_ account: String) -> String? {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
                                      kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
}
