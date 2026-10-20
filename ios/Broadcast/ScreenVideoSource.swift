// ReplayKit's screen frames, made ready for the H.264 encoder:
// - scaled into the preset and turned upright in VideoToolbox, into our own
//   small pool of buffers. libwebrtc then hands them to the hardware encoder
//   as they are; left to itself it would make full-size CPU copies, which the
//   extension's ~50 MB limit can't afford on an iPad's 2732x2048 screen.
// - sent at a constant frame rate. ReplayKit only delivers a frame when the
//   screen changes, so a still screen would otherwise send nothing (the
//   studio's constantFrameRate pacer does the same for browsers).
import CoreMedia
import CoreVideo
import QuartzCore
import ReplayKit
import VideoToolbox
import WebRTC
import DhamriCore

final class ScreenVideoSource {
    private let source: RTCVideoSource
    private let capturer: RTCVideoCapturer
    private let preset: QualityPreset
    private let fps: Int
    private let queue = DispatchQueue(label: "dhamri.video", qos: .userInteractive)
    private let lock = NSLock()

    /// The newest processed frame; the timer sends it until a newer one comes.
    private var latest: (buffer: CVPixelBuffer, rotation: RTCVideoRotation)?
    private var timer: DispatchSourceTimer?

    // Touched only from ReplayKit's (serial) sample callback.
    private var gate: FrameGate
    private var scaler: VTPixelTransferSession?
    private var rotator: VTPixelRotationSession?
    private var scaledPool: (pool: CVPixelBufferPool, size: PixelSize)?
    private var rotatedPool: (pool: CVPixelBufferPool, size: PixelSize)?

    init(source: RTCVideoSource, preset: QualityPreset, fps: Int) {
        self.source = source
        self.capturer = RTCVideoCapturer(delegate: source)
        self.preset = preset
        self.fps = fps
        self.gate = FrameGate(fps: fps)
    }

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: 1.0 / Double(fps), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in self?.emit() }
        timer.resume()
        self.timer = timer
    }

    func stop() {
        timer?.cancel()
        timer = nil
        lock.withLock { latest = nil }
    }

    func push(_ sampleBuffer: CMSampleBuffer) {
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let time = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        guard gate.accept(at: time.isFinite ? time : CACurrentMediaTime()) else { return }
        let orientation = (CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber)?.uint32Value ?? 1
        guard let frame = process(pixels, rotation: ScreenRotation(orientation: orientation)) else { return }
        lock.withLock { latest = frame }
    }

    private func emit() {
        guard let frame = lock.withLock({ latest }) else { return }
        let timeStampNs = Int64(CACurrentMediaTime() * 1_000_000_000)
        let videoFrame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: frame.buffer), rotation: frame.rotation, timeStampNs: timeStampNs)
        source.capturer(capturer, didCapture: videoFrame)
    }

    // MARK: - Scaling and rotation

    private func process(_ input: CVPixelBuffer, rotation: ScreenRotation) -> (buffer: CVPixelBuffer, rotation: RTCVideoRotation)? {
        let size = PixelSize(width: CVPixelBufferGetWidth(input), height: CVPixelBufferGetHeight(input))
        let upright = FrameGeometry.outputSize(source: size, rotation: rotation, preset: preset)
        // Scale first, so fewer pixels are turned. Always copy, even at full
        // size: holding on to ReplayKit's own buffers starves its pool.
        let scaledSize = rotation.swapsSides ? PixelSize(width: upright.height, height: upright.width) : upright
        guard let scaled = scale(input, to: scaledSize) else { return nil }
        guard rotation != .upright else { return (scaled, ._0) }
        if let turned = rotate(scaled, rotation, to: upright) { return (turned, ._0) }
        // VideoToolbox couldn't turn it: tell WebRTC, which rotates on the CPU.
        return (scaled, RTCVideoRotation(rawValue: rotation.rawValue) ?? ._0)
    }

    private func scale(_ input: CVPixelBuffer, to size: PixelSize) -> CVPixelBuffer? {
        if scaler == nil {
            var session: VTPixelTransferSession?
            guard VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &session) == noErr,
                  let session else { return nil }
            VTSessionSetProperty(session, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Normal)
            scaler = session
        }
        guard let scaler, let output = makeBuffer(&scaledPool, size: size) else { return nil }
        return VTPixelTransferSessionTransferImage(scaler, from: input, to: output) == noErr ? output : nil
    }

    private func rotate(_ input: CVPixelBuffer, _ rotation: ScreenRotation, to size: PixelSize) -> CVPixelBuffer? {
        if rotator == nil {
            var session: VTPixelRotationSession?
            guard VTPixelRotationSessionCreate(allocator: kCFAllocatorDefault, pixelRotationSessionOut: &session) == noErr,
                  let session else { return nil }
            rotator = session
        }
        let angle: CFString
        switch rotation {
        case .upright: angle = kVTRotation_0
        case .cw90: angle = kVTRotation_CW90
        case .upsideDown: angle = kVTRotation_180
        case .cw270: angle = kVTRotation_CCW90
        }
        guard let rotator, let output = makeBuffer(&rotatedPool, size: size) else { return nil }
        VTSessionSetProperty(rotator, key: kVTPixelRotationPropertyKey_Rotation, value: angle)
        return VTPixelRotationSessionRotateImage(rotator, from: input, to: output) == noErr ? output : nil
    }

    /// A buffer from a pool of `size` (recreated when the size changes, e.g.
    /// the iPad turned). The allocation threshold caps how many frames can be
    /// in flight; past it the frame is dropped rather than memory grown.
    private func makeBuffer(_ pool: inout (pool: CVPixelBufferPool, size: PixelSize)?, size: PixelSize) -> CVPixelBuffer? {
        if pool?.size != size {
            let attributes: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
                kCVPixelBufferWidthKey as String: size.width,
                kCVPixelBufferHeightKey as String: size.height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
            ]
            let poolAttributes: [String: Any] = [kCVPixelBufferPoolMinimumBufferCountKey as String: 3]
            var created: CVPixelBufferPool?
            guard CVPixelBufferPoolCreate(kCFAllocatorDefault, poolAttributes as CFDictionary, attributes as CFDictionary, &created) == kCVReturnSuccess,
                  let created else { return nil }
            pool = (created, size)
        }
        guard let current = pool?.pool else { return nil }
        var buffer: CVPixelBuffer?
        let limit = [kCVPixelBufferPoolAllocationThresholdKey as String: 6] as CFDictionary
        guard CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, current, limit, &buffer) == kCVReturnSuccess else { return nil }
        return buffer
    }
}
