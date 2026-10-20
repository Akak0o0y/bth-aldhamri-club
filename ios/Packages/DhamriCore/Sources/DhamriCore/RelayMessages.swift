// Messages for the realtime relay's WebSocket (server/realtime.js): the hello
// that joins a room and the streamer's hold ("be right back"), which viewers
// see as a card and a timer. Same fields as src/realtime/channel.js.
import Foundation

public enum RelayMessage {
    private struct Hello: Encodable {
        let t = "hello"
        let room: String
        let id: String
        let voter: String
        let name: String
        let host = true
    }

    private struct HoldOn: Encodable {
        let t = "hold"
        let on = true
        /// How long ago the hold began, not a timestamp, so device clocks
        /// don't matter.
        let elapsed: Int
        let note: String
        let token: String
    }

    private struct HoldOff: Encodable {
        let t = "hold"
        let on = false
        /// The hold stopped because the broadcast did, not because it resumed.
        let ended: Bool
        let token: String
    }

    private static func encode<T: Encodable>(_ value: T) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try! encoder.encode(value), as: UTF8.self)
    }

    /// Joins the channel's room as its host. `id` and `voter` must match
    /// /^[a-z0-9]{6,16}$/ or the relay picks its own.
    public static func hello(room: String, id: String, voter: String, name: String) -> String {
        encode(Hello(room: room, id: id, voter: voter, name: name))
    }

    /// The relay only takes a hold from the channel owner's session token.
    public static func holdStart(elapsedMs: Int, note: String, token: String) -> String {
        encode(HoldOn(elapsed: max(0, elapsedMs), note: String(note.prefix(80)), token: token))
    }

    public static func holdEnd(ended: Bool, token: String) -> String {
        encode(HoldOff(ended: ended, token: token))
    }
}
