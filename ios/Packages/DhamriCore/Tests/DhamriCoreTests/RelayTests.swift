import Foundation
import XCTest
@testable import DhamriCore

final class RelayTests: XCTestCase {
    func testHelloJoinsAsHost() {
        XCTAssertEqual(
            RelayMessage.hello(room: "streamer1", id: "abc12345", voter: "def67890", name: "Aziz"),
            #"{"host":true,"id":"abc12345","name":"Aziz","room":"streamer1","t":"hello","voter":"def67890"}"#
        )
    }

    func testHoldMessagesCarryTheToken() {
        XCTAssertEqual(
            RelayMessage.holdStart(elapsedMs: 1500, note: "", token: "tok"),
            #"{"elapsed":1500,"note":"","on":true,"t":"hold","token":"tok"}"#
        )
        XCTAssertEqual(
            RelayMessage.holdEnd(ended: true, token: "tok"),
            #"{"ended":true,"on":false,"t":"hold","token":"tok"}"#
        )
        XCTAssertTrue(RelayMessage.holdStart(elapsedMs: -5, note: String(repeating: "x", count: 100), token: "t")
            .contains(#""elapsed":0,"note":"\#(String(repeating: "x", count: 80))""#))
    }

    func testWhipAnswers() {
        let endpoint = URL(string: "https://media.example.org/streamer1/whip?session=ab12cd34")!
        let ok = WhipClient.interpret(status: 201, body: "v=0\r\n", location: "/streamer1/whip/9f8e", endpoint: endpoint)
        XCTAssertEqual(ok, .success(WhipAnswer(sdp: "v=0\r\n", resource: URL(string: "https://media.example.org/streamer1/whip/9f8e")!)))
        XCTAssertEqual(WhipClient.interpret(status: 401, body: "", location: nil, endpoint: endpoint), .failure(.unauthorized))
        XCTAssertEqual(WhipClient.interpret(status: 403, body: "", location: nil, endpoint: endpoint), .failure(.unauthorized))
        XCTAssertEqual(
            WhipClient.interpret(status: 400, body: #"{"error":"codecs not supported"}"#, location: nil, endpoint: endpoint),
            .failure(.rejected(status: 400, detail: "codecs not supported"))
        )
        XCTAssertEqual(
            WhipClient.interpret(status: 500, body: "boom\n", location: nil, endpoint: endpoint),
            .failure(.rejected(status: 500, detail: "boom"))
        )
    }

    func testRelayErrorsUseTheSiteWording() {
        XCTAssertEqual(RelayError.from(status: 401, body: Data(#"{"error":"login"}"#.utf8)), .login)
        XCTAssertEqual(RelayError.from(status: 429, body: Data(#"{"error":"busy"}"#.utf8)), .busy)
        XCTAssertEqual(RelayError.from(status: 401, body: Data(#"{"error":"session"}"#.utf8)), .session)
        XCTAssertEqual(RelayError.from(status: 502, body: Data("<html>".utf8)), .status(502))
        XCTAssertEqual(RelayError.login.errorDescription, "اسم المستخدم أو كلمة المرور غير صحيحة")
    }

    func testLoginReplyDecodes() throws {
        let json = #"{"name":"streamer1","owner":false,"room":"streamer1","token":"abc.def"}"#
        let session = try JSONDecoder().decode(StreamerSession.self, from: Data(json.utf8))
        XCTAssertEqual(session, StreamerSession(name: "streamer1", owner: false, room: "streamer1", token: "abc.def"))
        let me = try JSONDecoder().decode(Account.self, from: Data(#"{"name":"x","owner":true,"room":null}"#.utf8))
        XCTAssertNil(me.room)
    }
}
