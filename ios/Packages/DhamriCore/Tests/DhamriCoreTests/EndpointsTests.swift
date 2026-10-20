import Foundation
import XCTest
@testable import DhamriCore

final class EndpointsTests: XCTestCase {
    func testWhipURLMatchesTheStudio() {
        let channel = Channel(room: " /streamer1/ ")
        XCTAssertEqual(channel.room, "streamer1")
        XCTAssertEqual(channel.whipURL.absoluteString, "https://145-241-106-1.sslip.io/streamer1/whip")
        XCTAssertEqual(channel.whipURL(session: "ab12cd34").absoluteString, "https://145-241-106-1.sslip.io/streamer1/whip?session=ab12cd34")
    }

    func testEmptyRoomIsTheOwnersChannel() {
        XCTAssertEqual(Channel(room: "  ").room, "majlis")
    }

    func testArabicRoomIsPercentEncoded() {
        let url = Channel(room: "ضمري").whipURL
        XCTAssertEqual(url.absoluteString, "https://145-241-106-1.sslip.io/%D8%B6%D9%85%D8%B1%D9%8A/whip")
    }

    func testWatchLinkCarriesTheServerOnlyWhenCustom() {
        XCTAssertEqual(Channel(room: "streamer1").watchURL().absoluteString, "https://dhamri.vercel.app/?room=streamer1")
        let custom = Channel(server: URL(string: "https://media.example.org/")!, room: "a")
        XCTAssertEqual(custom.watchURL().absoluteString, "https://dhamri.vercel.app/?server=https://media.example.org&room=a")
        XCTAssertEqual(custom.whipURL.absoluteString, "https://media.example.org/a/whip")
    }

    func testSocketURL() {
        XCTAssertEqual(Servers.socketURL(relay: Servers.relay).absoluteString, "wss://realtime-production-988e.up.railway.app")
        XCTAssertEqual(Servers.socketURL(relay: URL(string: "http://192.168.1.4:8787")!).absoluteString, "ws://192.168.1.4:8787")
    }

    func testCleanServer() {
        XCTAssertEqual(Servers.clean(" https://media.example.org// ")?.absoluteString, "https://media.example.org")
        XCTAssertNil(Servers.clean("ftp://media.example.org"))
        XCTAssertNil(Servers.clean("not a url"))
    }

    func testRandomIDsSuitTheRelay() {
        let id = RandomID.make()
        XCTAssertEqual(id.count, 8)
        XCTAssertTrue(id.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) })
        XCTAssertNotEqual(RandomID.make(length: 12), RandomID.make(length: 12))
    }
}
