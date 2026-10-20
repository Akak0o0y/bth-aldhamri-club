import Foundation
import XCTest
@testable import DhamriCore

final class QualityTests: XCTestCase {
    // presetKbps() in src/stream/controller.js gives the same at 30 fps.
    func testBitratesFollowTheStudio() {
        XCTAssertEqual(QualityPreset.fullHD1080.videoKbps(fps: 30), 4600)
        XCTAssertEqual(QualityPreset.hd720.videoKbps(fps: 30), 2300)
        XCTAssertEqual(QualityPreset.fullHD1080.videoKbps(fps: 60), 7000)
        XCTAssertEqual(BroadcastSettings().tuning, PublishTuning(videoKbps: 4600, audioKbps: 96, music: false))
    }

    func testPhonePortraitFitsTheTallBox() {
        // iPhone 15: 1179x2556, upright.
        let size = FrameGeometry.outputSize(source: PixelSize(width: 1179, height: 2556), rotation: .upright, preset: .fullHD1080)
        XCTAssertEqual(size, PixelSize(width: 886, height: 1920))
    }

    func testIPadLandscapeIsTurnedAndFitted() {
        // iPad mini 6 buffers are portrait (1488x2266) with a left/right
        // orientation when the iPad is held sideways.
        let size = FrameGeometry.outputSize(source: PixelSize(width: 1488, height: 2266), rotation: .cw90, preset: .fullHD1080)
        XCTAssertEqual(size, PixelSize(width: 1644, height: 1080))
        let hd = FrameGeometry.outputSize(source: PixelSize(width: 1488, height: 2266), rotation: .cw270, preset: .hd720)
        XCTAssertEqual(hd, PixelSize(width: 1096, height: 720))
    }

    func testSmallScreensAreNeverEnlarged() {
        let size = FrameGeometry.outputSize(source: PixelSize(width: 750, height: 1334), rotation: .upright, preset: .fullHD1080)
        XCTAssertEqual(size, PixelSize(width: 750, height: 1334))
        let odd = FrameGeometry.outputSize(source: PixelSize(width: 641, height: 359), rotation: .upright, preset: .fullHD1080)
        XCTAssertEqual(odd, PixelSize(width: 640, height: 358))
    }

    func testOrientationMapping() {
        XCTAssertEqual(ScreenRotation(orientation: 1), .upright)
        XCTAssertEqual(ScreenRotation(orientation: 8), .cw90)
        XCTAssertEqual(ScreenRotation(orientation: 6), .cw270)
        XCTAssertEqual(ScreenRotation(orientation: 3), .upsideDown)
        XCTAssertEqual(ScreenRotation(orientation: 99), .upright)
    }

    func testFrameGateKeepsThirtyOfSixty() {
        var gate = FrameGate(fps: 30)
        let accepted = (0..<60).filter { gate.accept(at: Double($0) / 60) }
        XCTAssertEqual(accepted.count, 30)
    }

    func testFrameGateToleratesJitterAtThirty() {
        var gate = FrameGate(fps: 30)
        let times: [Double] = (0..<30).map { (i: Int) -> Double in
            let jitter: Double = i % 2 == 0 ? 0.003 : -0.003
            return Double(i) / 30 + jitter
        }
        XCTAssertEqual(times.filter { gate.accept(at: $0) }.count, 30)
    }
}
