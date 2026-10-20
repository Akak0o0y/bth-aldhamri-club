// Where the site's servers live, and the URLs a broadcast needs. Mirrors
// src/stream/config.js (media server, WHIP path, invite link) and
// src/realtime/relay.js (accounts API and chat socket).
import Foundation

public enum Servers {
    /// MediaMTX on the Oracle VM in Riyadh (server/gulf/setup.sh): WebRTC over
    /// UDP 8189 with a TCP fallback on the same port.
    public static let media = URL(string: "https://145-241-106-1.sslip.io")!
    /// The realtime relay (server/realtime.js): accounts over HTTPS, chat and
    /// the hold notice over a WebSocket on the same host.
    public static let relay = URL(string: "https://realtime-production-988e.up.railway.app")!
    /// The site viewers open.
    public static let site = URL(string: "https://dhamri.vercel.app")!

    /// The relay's WebSocket address: same host, ws(s) scheme.
    public static func socketURL(relay: URL) -> URL {
        var parts = URLComponents(url: relay, resolvingAgainstBaseURL: false)!
        parts.scheme = parts.scheme == "http" ? "ws" : "wss"
        return parts.url!
    }

    /// "https://host/" and "https://host" are the same server; anything that
    /// isn't an http(s) address is rejected.
    public static func clean(_ server: String) -> URL? {
        var text = server.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host != nil else {
            return nil
        }
        return url
    }
}

/// A streamer's channel: the MediaMTX path they publish to, which is also the
/// relay room their chat lives in.
public struct Channel: Equatable, Sendable {
    public let server: URL
    public let room: String

    public init(server: URL = Servers.media, room: String) {
        self.server = server
        self.room = Channel.clean(room)
    }

    /// Same rule as cleanRoom() in config.js: trimmed, no leading or trailing
    /// slashes, and the owner's channel when empty.
    public static func clean(_ room: String) -> String {
        let trimmed = room
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return trimmed.isEmpty ? "majlis" : trimmed
    }

    // Account names may be Arabic; the browser's fetch() encodes those itself.
    private var escapedRoom: String {
        room.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? room
    }

    private var base: String {
        var text = server.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text
    }

    /// `<server>/<room>/whip`, what the studio and OBS publish to.
    public var whipURL: URL { URL(string: "\(base)/\(escapedRoom)/whip")! }

    /// The WHIP URL for one broadcast. The relay starts the channel's chat
    /// over only when `session` changes, so reconnects reuse it.
    public func whipURL(session: String) -> URL {
        URL(string: "\(base)/\(escapedRoom)/whip?session=\(session)")!
    }

    /// The link viewers open. The server rides along only when it isn't the
    /// default one, like inviteLink() in config.js.
    public func watchURL(site: URL = Servers.site) -> URL {
        var parts = URLComponents(url: site, resolvingAgainstBaseURL: false)!
        if parts.path.isEmpty { parts.path = "/" }
        var query: [URLQueryItem] = []
        if server != Servers.media { query.append(URLQueryItem(name: "server", value: base)) }
        query.append(URLQueryItem(name: "room", value: room))
        parts.queryItems = query
        return parts.url!
    }
}

public enum RandomID {
    private static let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")

    /// Lowercase letters and digits, like Math.random().toString(36) in the
    /// studio. The relay accepts ids matching /^[a-z0-9]{6,16}$/.
    public static func make(length: Int = 8) -> String {
        var generator = SystemRandomNumberGenerator()
        return String((0..<length).map { _ in alphabet.randomElement(using: &generator)! })
    }
}
