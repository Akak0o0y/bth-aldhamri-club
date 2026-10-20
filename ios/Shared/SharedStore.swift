// What the app and the broadcast extension share through their App Group:
// the streamer's session in the Keychain (the App Group id doubles as the
// keychain access group), and the quality settings plus the broadcast's live
// status in the group's UserDefaults.
import Foundation
import Security
import DhamriCore

struct BroadcastStatus: Codable, Equatable {
    enum State: String, Codable {
        case idle, connecting, live, reconnecting, paused, error
    }

    var state: State
    var message: String = ""
    var updated = Date()

    /// The extension rewrites its status every few seconds while it runs; an
    /// older "live" means it was stopped without saying so (or killed).
    var isStale: Bool { Date().timeIntervalSince(updated) > 10 }
}

enum SharedStore {
    /// From the DHAMRI_APP_GROUP build setting, through Info.plist.
    static let appGroup = Bundle.main.object(forInfoDictionaryKey: "DhamriAppGroup") as? String ?? "group.com.dhamri.broadcaster"

    static var defaults: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }

    // MARK: - Session (Keychain)

    private static func keychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dhamri.session",
            kSecAttrAccount as String: "streamer",
            kSecAttrAccessGroup as String: appGroup,
        ]
    }

    static func loadSession() -> StreamerSession? {
        var query = keychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(StreamerSession.self, from: data)
    }

    /// Readable after the first unlock, so a broadcast keeps its session when
    /// the screen locks.
    @discardableResult
    static func saveSession(_ session: StreamerSession) -> Bool {
        guard let data = try? JSONEncoder().encode(session) else { return false }
        let fields: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        var status = SecItemUpdate(keychainQuery() as CFDictionary, fields as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(keychainQuery().merging(fields) { $1 } as CFDictionary, nil)
        }
        return status == errSecSuccess
    }

    static func clearSession() {
        SecItemDelete(keychainQuery() as CFDictionary)
    }

    // MARK: - Settings and status (App Group defaults)

    private static func read<T: Decodable>(_ key: String) -> T? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    private static func write<T: Encodable>(_ value: T?, _ key: String) {
        defaults.set(value.flatMap { try? JSONEncoder().encode($0) }, forKey: key)
    }

    static var settings: BroadcastSettings {
        get { read("settings") ?? BroadcastSettings() }
        set { write(newValue, "settings") }
    }

    static var status: BroadcastStatus? {
        get { read("status") }
        set { write(newValue, "status") }
    }

    /// For testing against another stack (a local MediaMTX and relay); the
    /// site's own servers when unset.
    static var mediaServer: URL {
        defaults.string(forKey: "mediaServer").flatMap(Servers.clean) ?? Servers.media
    }

    static var relayServer: URL {
        defaults.string(forKey: "relayServer").flatMap(Servers.clean) ?? Servers.relay
    }

    /// One id per device for the relay's "who's here" list, like the voter id
    /// the site keeps in localStorage.
    static var deviceID: String {
        if let id = defaults.string(forKey: "voter"), id.count >= 6 { return id }
        let id = RandomID.make()
        defaults.set(id, forKey: "voter")
        return id
    }
}
