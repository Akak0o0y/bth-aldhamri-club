// What the broadcast sends: resolution, frame rate, bitrate, and how the
// screen's frames are sized and paced. Numbers follow the studio's presets
// (PRESETS and presetKbps in src/stream/controller.js) for H.264.
import Foundation

public enum QualityPreset: String, CaseIterable, Codable, Sendable {
    case hd720 = "720"
    case fullHD1080 = "1080"

    public var label: String { self == .hd720 ? "720p" : "1080p" }

    /// The box frames are fitted into, landscape.
    public var longSide: Int { self == .hd720 ? 1280 : 1920 }
    public var shortSide: Int { self == .hd720 ? 720 : 1080 }

    /// H.264 bitrate for this size; below 50 fps the studio uses 65% of it.
    public func videoKbps(fps: Int) -> Int {
        let base = Double(self == .hd720 ? 3500 : 7000)
        return Int(((fps >= 50 ? base : base * 0.65) / 100).rounded()) * 100
    }
}

/// What stays fixed when the network or encoder can't keep up — the
/// streamer's choice, as in the studio.
public enum ContentHint: String, CaseIterable, Codable, Sendable {
    /// Screens and text: keep the resolution, drop frames.
    case detail
    /// Games and films: keep the frame rate, lower the resolution.
    case motion
}

public struct BroadcastSettings: Codable, Equatable, Sendable {
    public var preset: QualityPreset
    public var hint: ContentHint

    public init(preset: QualityPreset = .fullHD1080, hint: ContentHint = .detail) {
        self.preset = preset
        self.hint = hint
    }

    /// ReplayKit delivers about 30 screen frames a second at most for a
    /// broadcast, so that is what we send.
    public var fps: Int { 30 }
    public var videoKbps: Int { preset.videoKbps(fps: fps) }
    /// One mono Opus stream carries the app audio and the microphone.
    public var audioKbps: Int { 96 }

    public var tuning: PublishTuning { PublishTuning(videoKbps: videoKbps, audioKbps: audioKbps, music: false) }
}

public struct PixelSize: Equatable, Sendable, CustomStringConvertible {
    public var width: Int
    public var height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    public var description: String { "\(width)x\(height)" }
}

/// How far a ReplayKit frame must turn, clockwise, to be upright.
public enum ScreenRotation: Int, Sendable {
    case upright = 0
    case cw90 = 90
    case upsideDown = 180
    case cw270 = 270

    /// From the CGImagePropertyOrientation raw value ReplayKit attaches to each
    /// frame (RPVideoSampleOrientationKey). The mapping matches the screen
    /// capturers of react-native-webrtc and Agora's ReplayKit sample (left →
    /// 90°, right → 270°); check it on a device in both landscape directions.
    public init(orientation raw: UInt32) {
        switch raw {
        case 8, 5: self = .cw90 // left, leftMirrored
        case 6, 7: self = .cw270 // right, rightMirrored
        case 3, 4: self = .upsideDown // down, downMirrored
        default: self = .upright
        }
    }

    public var swapsSides: Bool { self == .cw90 || self == .cw270 }
}

public enum FrameGeometry {
    /// The size frames are sent at: the upright screen fitted into the
    /// preset's box (turned to match the screen), never enlarged, even sides.
    public static func outputSize(source: PixelSize, rotation: ScreenRotation, preset: QualityPreset) -> PixelSize {
        let upright = rotation.swapsSides ? PixelSize(width: source.height, height: source.width) : source
        guard upright.width > 0, upright.height > 0 else { return PixelSize(width: 0, height: 0) }
        let landscape = upright.width >= upright.height
        let boxWidth = Double(landscape ? preset.longSide : preset.shortSide)
        let boxHeight = Double(landscape ? preset.shortSide : preset.longSide)
        let scale = min(1, boxWidth / Double(upright.width), boxHeight / Double(upright.height))
        func even(_ value: Double) -> Int { max(2, Int(value.rounded()) & ~1) }
        return PixelSize(width: even(Double(upright.width) * scale), height: even(Double(upright.height) * scale))
    }
}

/// Drops screen frames that arrive faster than the frame rate, so a 60 Hz
/// display isn't scaled twice for every frame sent.
public struct FrameGate: Sendable {
    public let fps: Int
    private var last: Double?

    public init(fps: Int) { self.fps = fps }

    /// `time` in seconds on any steady clock. A little slack keeps a 30 fps
    /// source from losing frames to timing jitter.
    public mutating func accept(at time: Double) -> Bool {
        if let last, time - last < 0.75 / Double(fps), time >= last { return false }
        last = time
        return true
    }
}
