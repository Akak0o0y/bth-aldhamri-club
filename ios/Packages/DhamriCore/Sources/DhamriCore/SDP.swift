// SDP helpers for the WHIP publisher: a line-for-line port of
// src/stream/sdp.js, so the app sends MediaMTX exactly what the browser
// studio sends. Trickle-ICE and Link-header parsing follow MediaMTX's own
// publisher.js (github.com/bluenviron/mediamtx, internal/servers/webrtc).
import Foundation

public struct IceServer: Equatable, Sendable {
    public var urls: [String]
    public var username: String?
    public var credential: String?

    public init(urls: [String], username: String? = nil, credential: String? = nil) {
        self.urls = urls
        self.username = username
        self.credential = credential
    }
}

/// One local ICE candidate: the m-line it belongs to and its
/// "candidate:..." line (RTCIceCandidate.sdp on iOS).
public struct LocalCandidate: Equatable, Sendable {
    public var mLineIndex: Int
    public var line: String

    public init(mLineIndex: Int, line: String) {
        self.mLineIndex = mLineIndex
        self.line = line
    }
}

/// What a trickle-ICE PATCH needs from our offer.
public struct OfferInfo: Equatable, Sendable {
    public var iceUfrag = ""
    public var icePwd = ""
    public var medias: [String] = []
}

/// The send-side limits the studio writes into the SDP.
public struct PublishTuning: Equatable, Sendable {
    public var videoKbps: Int
    public var audioKbps: Int
    /// Stereo, full-band Opus (the studio's screen share). False is the
    /// speech profile, which is also what a mono capture should use.
    public var music: Bool

    public init(videoKbps: Int, audioKbps: Int, music: Bool) {
        self.videoKbps = videoKbps
        self.audioKbps = audioKbps
        self.music = music
    }
}

public enum SDP {
    public static let fallbackIceServers = [IceServer(urls: ["stun:stun.l.google.com:19302"])]

    public static func authorization(token: String) -> String { "Bearer \(token)" }

    private static let linkEntry = try! NSRegularExpression(
        pattern: #"^<(.+?)>; rel="ice-server"(; username="(.*?)"; credential="(.*?)"; credential-type="password")?"#,
        options: [.caseInsensitive]
    )

    /// ICE servers from the Link header MediaMTX sends on OPTIONS; nil when
    /// there is no header, so the caller falls back to public STUN.
    public static func iceServers(fromLink link: String?) -> [IceServer]? {
        guard let link, !link.isEmpty else { return nil }
        return link.components(separatedBy: ", ").compactMap { (entry: String) -> IceServer? in
            let range = NSRange(entry.startIndex..., in: entry)
            guard let match = linkEntry.firstMatch(in: entry, range: range) else { return nil }
            func group(_ index: Int) -> String? {
                guard let r = Range(match.range(at: index), in: entry) else { return nil }
                return String(entry[r])
            }
            guard let url = group(1) else { return nil }
            var server = IceServer(urls: [url])
            if let user = group(3), let credential = group(4) {
                server.username = unescapeJSON(user)
                server.credential = unescapeJSON(credential)
            }
            return server
        }
    }

    // The header quotes values as JSON strings (JSON.parse in the browser).
    private static func unescapeJSON(_ text: String) -> String {
        (try? JSONDecoder().decode(String.self, from: Data("\"\(text)\"".utf8))) ?? text
    }

    public static func parseOffer(_ sdp: String) -> OfferInfo {
        var out = OfferInfo()
        for line in sdp.components(separatedBy: "\r\n") {
            if line.hasPrefix("m=") {
                out.medias.append(String(line.dropFirst(2)))
            } else if out.iceUfrag.isEmpty, line.hasPrefix("a=ice-ufrag:") {
                out.iceUfrag = String(line.dropFirst(12))
            } else if out.icePwd.isEmpty, line.hasPrefix("a=ice-pwd:") {
                out.icePwd = String(line.dropFirst(10))
            }
        }
        return out
    }

    /// Body of the trickle-ICE PATCH (application/trickle-ice-sdpfrag).
    public static func fragment(offer: OfferInfo, candidates: [LocalCandidate]) -> String {
        var byMedia: [Int: [LocalCandidate]] = [:]
        for candidate in candidates { byMedia[candidate.mLineIndex, default: []].append(candidate) }
        var frag = "a=ice-ufrag:\(offer.iceUfrag)\r\na=ice-pwd:\(offer.icePwd)\r\n"
        for (mid, media) in offer.medias.enumerated() {
            guard let list = byMedia[mid] else { continue }
            frag += "m=\(media)\r\na=mid:\(mid)\r\n"
            for candidate in list { frag += "a=\(candidate.line)\r\n" }
        }
        return frag
    }

    // MARK: - Section editing

    private static func editMedia(_ sdp: String, kind: String, _ edit: (inout [String]) -> Void) -> String {
        var parts = sdp.components(separatedBy: "\r\nm=")
        for i in parts.indices.dropFirst() where parts[i].hasPrefix("\(kind) ") {
            var lines = parts[i].components(separatedBy: "\r\n")
            edit(&lines)
            parts[i] = lines.joined(separator: "\r\n")
        }
        return parts.joined(separator: "\r\nm=")
    }

    private static let rtpmap = try! NSRegularExpression(pattern: #"^a=rtpmap:(\d+) ([^/]+)/"#)

    private static func payloadTypes(_ lines: [String], codecs: Set<String>) -> [String] {
        lines.compactMap { (line: String) -> String? in
            let range = NSRange(line.startIndex..., in: line)
            guard let m = rtpmap.firstMatch(in: line, range: range),
                  let pt = Range(m.range(at: 1), in: line),
                  let name = Range(m.range(at: 2), in: line),
                  codecs.contains(line[name].uppercased()) else { return nil }
            return String(line[pt])
        }
    }

    /// Adds or overrides parameters on a payload type's a=fmtp line, keeping
    /// the order of the ones already there (a JS Map in the browser).
    private static func mergeFmtp(_ lines: inout [String], pt: String, params: [(String, String)]) {
        let prefix = "a=fmtp:\(pt) "
        var pairs: [(key: String, value: String)] = []
        func set(_ key: String, _ value: String) {
            if let i = pairs.firstIndex(where: { $0.key == key }) { pairs[i].value = value } else { pairs.append((key, value)) }
        }
        let existing = lines.firstIndex { $0.hasPrefix(prefix) }
        if let existing {
            for kv in lines[existing].dropFirst(prefix.count).split(separator: ";", omittingEmptySubsequences: false) {
                let text = String(kv)
                if text.trimmingCharacters(in: .whitespaces).isEmpty { continue }
                if let eq = text.firstIndex(of: "=") {
                    set(text[..<eq].trimmingCharacters(in: .whitespaces), text[text.index(after: eq)...].trimmingCharacters(in: .whitespaces))
                } else {
                    set(text.trimmingCharacters(in: .whitespaces), "")
                }
            }
        }
        for (key, value) in params { set(key, value) }
        let line = prefix + pairs.map { $0.value.isEmpty ? $0.key : "\($0.key)=\($0.value)" }.joined(separator: ";")
        if let existing {
            lines[existing] = line
        } else {
            let at = (lines.firstIndex { $0.hasPrefix("a=rtpmap:\(pt) ") } ?? -1) + 1
            lines.insert(line, at: at)
        }
    }

    private static func opusParams(music: Bool, audioKbps: Int) -> [(String, String)] {
        music
            ? [("stereo", "1"), ("sprop-stereo", "1"), ("maxaveragebitrate", "\(audioKbps * 1000)"), ("useinbandfec", "1"), ("usedtx", "0")]
            : [("minptime", "10"), ("useinbandfec", "1"), ("maxaveragebitrate", "\(audioKbps * 1000)")]
    }

    private static let videoCodecs: Set<String> = ["H264", "VP8", "VP9", "AV1", "H265"]

    /// Our offer: the Opus profile we want.
    public static func tunePublisherOffer(_ sdp: String, _ tuning: PublishTuning) -> String {
        editMedia(sdp, kind: "audio") { lines in
            for pt in payloadTypes(lines, codecs: ["OPUS"]) {
                mergeFmtp(&lines, pt: pt, params: opusParams(music: tuning.music, audioKbps: tuning.audioKbps))
            }
        }
    }

    /// MediaMTX's answer: libwebrtc reads its send-side limits from the remote
    /// description. x-google-start-bitrate skips the slow ramp-up so the first
    /// seconds are already sharp instead of starting near 300 kbps.
    public static func tunePublisherAnswer(_ sdp: String, _ tuning: PublishTuning) -> String {
        let kbps = tuning.videoKbps
        var out = editMedia(sdp, kind: "video") { lines in
            lines.removeAll { $0.hasPrefix("b=") }
            let at = (lines.firstIndex { $0.hasPrefix("c=") } ?? 0) + 1
            lines.insert(contentsOf: ["b=AS:\(kbps)", "b=TIAS:\(kbps * 1000)"], at: at)
            for pt in payloadTypes(lines, codecs: videoCodecs) {
                mergeFmtp(&lines, pt: pt, params: [
                    ("x-google-start-bitrate", "\(Int((Double(kbps) * 0.7).rounded()))"),
                    ("x-google-min-bitrate", "\(Int((Double(kbps) * 0.25).rounded()))"),
                    ("x-google-max-bitrate", "\(kbps)"),
                ])
            }
        }
        out = editMedia(out, kind: "audio") { lines in
            for pt in payloadTypes(lines, codecs: ["OPUS"]) {
                mergeFmtp(&lines, pt: pt, params: opusParams(music: tuning.music, audioKbps: tuning.audioKbps))
            }
        }
        return out
    }
}
