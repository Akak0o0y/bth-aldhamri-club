import Foundation
import XCTest
@testable import DhamriCore

final class AudioMixerTests: XCTestCase {
    func testSilenceWhenNothingIsQueued() {
        XCTAssertEqual(AudioMixer().pull(count: 4), [0, 0, 0, 0])
    }

    func testMixesBothSourcesAndPadsTheShortOne() {
        let mixer = AudioMixer()
        mixer.push([100, 200, 300, 400], from: .app)
        mixer.push([1, 2], from: .mic)
        XCTAssertEqual(mixer.pull(count: 4), [101, 202, 300, 400])
        XCTAssertEqual(mixer.buffered(.app), 0)
        XCTAssertEqual(mixer.buffered(.mic), 0)
    }

    func testKeepsWhatWasNotPulled() {
        let mixer = AudioMixer()
        mixer.push([1, 2, 3, 4, 5], from: .app)
        XCTAssertEqual(mixer.pull(count: 2), [1, 2])
        XCTAssertEqual(mixer.pull(count: 4), [3, 4, 5, 0])
    }

    func testClipsInsteadOfWrapping() {
        let mixer = AudioMixer()
        mixer.push([30_000, -30_000], from: .app)
        mixer.push([10_000, -10_000], from: .mic)
        XCTAssertEqual(mixer.pull(count: 2), [Int16.max, Int16.min])
    }

    func testDropsTheOldestWhenASourceRunsAhead() {
        let mixer = AudioMixer(maxBuffered: 3)
        mixer.push([1, 2, 3, 4, 5], from: .mic)
        XCTAssertEqual(mixer.buffered(.mic), 3)
        XCTAssertEqual(mixer.pull(count: 3), [3, 4, 5])
    }
}
