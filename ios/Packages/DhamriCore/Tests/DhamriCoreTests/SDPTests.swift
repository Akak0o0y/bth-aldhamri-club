// Expected strings come from running the site's src/stream/sdp.js in Node on
// the same input, so the app's SDP must match the browser studio's exactly.
import XCTest
@testable import DhamriCore

private func sdp(_ lines: [String]) -> String { lines.joined(separator: "\r\n") + "\r\n" }

private let offer = sdp([
    "v=0", "o=- 4611 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0 1",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 97", "c=IN IP4 0.0.0.0", "a=ice-ufrag:AbCd", "a=ice-pwd:secretpwd1234567890abcd",
    "a=mid:0", "a=sendonly", "a=rtpmap:96 H264/90000",
    "a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    "a=rtpmap:97 rtx/90000", "a=fmtp:97 apt=96",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 63", "c=IN IP4 0.0.0.0", "a=ice-ufrag:AbCd", "a=ice-pwd:secretpwd1234567890abcd",
    "a=mid:1", "a=sendonly", "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1", "a=rtpmap:63 red/48000/2",
])

private let answer = sdp([
    "v=0", "o=- 99 2 IN IP4 0.0.0.0", "s=-", "t=0 0", "a=group:BUNDLE 0 1",
    "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", "b=AS:500", "a=mid:0", "a=recvonly", "a=rtpmap:96 H264/90000",
    "a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=mid:1", "a=recvonly", "a=rtpmap:111 opus/48000/2",
])

final class SDPTests: XCTestCase {
    func testOfferGetsTheSpeechOpusProfile() {
        let tuned = SDP.tunePublisherOffer(offer, PublishTuning(videoKbps: 4600, audioKbps: 96, music: false))
        XCTAssertEqual(tuned, offer.replacingOccurrences(
            of: "a=fmtp:111 minptime=10;useinbandfec=1\r\n",
            with: "a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=96000\r\n"
        ))
    }

    func testAnswerGetsBitrateLimitsAndOpusParams() {
        let tuned = SDP.tunePublisherAnswer(answer, PublishTuning(videoKbps: 4600, audioKbps: 96, music: false))
        XCTAssertEqual(tuned, sdp([
            "v=0", "o=- 99 2 IN IP4 0.0.0.0", "s=-", "t=0 0", "a=group:BUNDLE 0 1",
            "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", "b=AS:4600", "b=TIAS:4600000", "a=mid:0", "a=recvonly",
            "a=rtpmap:96 H264/90000",
            "a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=3220;x-google-min-bitrate=1150;x-google-max-bitrate=4600",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=mid:1", "a=recvonly", "a=rtpmap:111 opus/48000/2",
            "a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=96000",
        ]))
    }

    func testMusicAnswerAddsStereoAfterTheRtpmap() {
        let tuned = SDP.tunePublisherAnswer(answer, PublishTuning(videoKbps: 2300, audioKbps: 128, music: true))
        XCTAssertTrue(tuned.contains("b=AS:2300\r\nb=TIAS:2300000\r\n"))
        XCTAssertTrue(tuned.contains("x-google-start-bitrate=1610;x-google-min-bitrate=575;x-google-max-bitrate=2300"))
        XCTAssertTrue(tuned.hasSuffix(
            "a=rtpmap:111 opus/48000/2\r\na=fmtp:111 stereo=1;sprop-stereo=1;maxaveragebitrate=128000;useinbandfec=1;usedtx=0\r\n"
        ))
    }

    func testParseOffer() {
        let parsed = SDP.parseOffer(offer)
        XCTAssertEqual(parsed.iceUfrag, "AbCd")
        XCTAssertEqual(parsed.icePwd, "secretpwd1234567890abcd")
        XCTAssertEqual(parsed.medias, ["video 9 UDP/TLS/RTP/SAVPF 96 97", "audio 9 UDP/TLS/RTP/SAVPF 111 63"])
    }

    func testTrickleFragmentGroupsCandidatesByMedia() {
        let fragment = SDP.fragment(offer: SDP.parseOffer(offer), candidates: [
            LocalCandidate(mLineIndex: 0, line: "candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host"),
            LocalCandidate(mLineIndex: 1, line: "candidate:2 1 udp 2122260223 192.168.1.5 50001 typ host"),
            LocalCandidate(mLineIndex: 0, line: "candidate:3 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active"),
        ])
        XCTAssertEqual(fragment, sdp([
            "a=ice-ufrag:AbCd", "a=ice-pwd:secretpwd1234567890abcd",
            "m=video 9 UDP/TLS/RTP/SAVPF 96 97", "a=mid:0",
            "a=candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host",
            "a=candidate:3 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111 63", "a=mid:1",
            "a=candidate:2 1 udp 2122260223 192.168.1.5 50001 typ host",
        ]))
    }

    func testLinkHeader() {
        let link = #"<stun:stun.example.org:3478>; rel="ice-server", <turn:turn.example.org:3478?transport=udp>; rel="ice-server"; username="us\"er"; credential="pass"; credential-type="password", <bogus>"#
        XCTAssertEqual(SDP.iceServers(fromLink: link), [
            IceServer(urls: ["stun:stun.example.org:3478"]),
            IceServer(urls: ["turn:turn.example.org:3478?transport=udp"], username: "us\"er", credential: "pass"),
        ])
        XCTAssertNil(SDP.iceServers(fromLink: nil))
        XCTAssertNil(SDP.iceServers(fromLink: ""))
    }
}
