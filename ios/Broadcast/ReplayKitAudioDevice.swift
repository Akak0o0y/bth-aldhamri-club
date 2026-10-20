// WebRTC's microphone, replaced. A broadcast extension can't open an audio
// unit, so libwebrtc's own audio device won't work here; instead this device
// feeds it what ReplayKit hands over — app audio, and the microphone when the
// streamer switched it on in the picker — converted to 48 kHz mono and mixed.
// Mono because libwebrtc's ObjC audio module reads delivered buffers as one
// channel (ObjCAudioDeviceModule::OnDeliverRecordedData).
import AVFoundation
import CoreMedia
import WebRTC
import DhamriCore

final class ReplayKitAudioDevice: NSObject, RTCAudioDevice {
    private static let sampleRate = 48_000.0
    /// 10 ms, the size WebRTC works in.
    private static let chunk = 480

    private let mixer = AudioMixer()
    private let queue = DispatchQueue(label: "dhamri.audio", qos: .userInteractive)
    private let lock = NSLock()
    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: ReplayKitAudioDevice.sampleRate, channels: 1, interleaved: true)!
    private var converters: [AudioMixer.Source: AVAudioConverter] = [:]
    private var delegate: RTCAudioDeviceDelegate?
    private var timer: DispatchSourceTimer?
    private var sampleTime = 0.0
    private var recording = false

    // MARK: - RTCAudioDevice

    var deviceInputSampleRate: Double { Self.sampleRate }
    var inputIOBufferDuration: TimeInterval { Double(Self.chunk) / Self.sampleRate }
    var inputNumberOfChannels: Int { 1 }
    var inputLatency: TimeInterval { 0 }
    var deviceOutputSampleRate: Double { Self.sampleRate }
    var outputIOBufferDuration: TimeInterval { Double(Self.chunk) / Self.sampleRate }
    var outputNumberOfChannels: Int { 1 }
    var outputLatency: TimeInterval { 0 }

    private(set) var isInitialized = false
    private(set) var isPlayoutInitialized = false
    private(set) var isPlaying = false
    private(set) var isRecordingInitialized = false
    var isRecording: Bool { lock.withLock { recording } }

    func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
        self.delegate = delegate
        isInitialized = true
        return true
    }

    func terminateDevice() -> Bool {
        _ = stopRecording()
        _ = stopPlayout()
        delegate = nil
        isInitialized = false
        return true
    }

    // Send-only: nothing is ever played.
    func initializePlayout() -> Bool {
        isPlayoutInitialized = true
        return true
    }

    func startPlayout() -> Bool {
        isPlaying = true
        return true
    }

    func stopPlayout() -> Bool {
        isPlaying = false
        return true
    }

    func initializeRecording() -> Bool {
        isRecordingInitialized = true
        return true
    }

    func startRecording() -> Bool {
        guard !isRecording else { return true }
        mixer.reset()
        lock.withLock { recording = true }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: inputIOBufferDuration, leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in self?.deliver() }
        timer.resume()
        self.timer = timer
        return true
    }

    func stopRecording() -> Bool {
        lock.withLock { recording = false }
        timer?.cancel()
        timer = nil
        mixer.reset()
        return true
    }

    // MARK: - ReplayKit in, WebRTC out

    /// Called on ReplayKit's thread for every app or microphone buffer.
    func push(_ sampleBuffer: CMSampleBuffer, from source: AudioMixer.Source) {
        guard isRecording,
              let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              var format = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else { return }
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0 else { return }

        // App audio often arrives as big-endian 16-bit; read it as native and
        // swap the bytes ourselves.
        let bigEndian = format.mFormatFlags & kAudioFormatFlagIsBigEndian != 0
        if bigEndian { format.mFormatFlags &= ~kAudioFormatFlagIsBigEndian }
        guard let inputFormat = AVAudioFormat(streamDescription: &format),
              let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
        input.frameLength = AVAudioFrameCount(frames)
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(frames), into: input.mutableAudioBufferList) == noErr else { return }
        if bigEndian { Self.swapBytes(input, bits: Int(format.mBitsPerChannel)) }

        guard let converter = converter(for: source, from: inputFormat) else { return }
        let capacity = AVAudioFrameCount(Double(frames) * Self.sampleRate / inputFormat.sampleRate) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return input
        }
        guard status != .error, let samples = output.int16ChannelData, output.frameLength > 0 else { return }
        mixer.push(UnsafeBufferPointer(start: samples[0], count: Int(output.frameLength)), from: source)
    }

    private func converter(for source: AudioMixer.Source, from format: AVAudioFormat) -> AVAudioConverter? {
        if let existing = converters[source], existing.inputFormat == format { return existing }
        guard let converter = AVAudioConverter(from: format, to: outputFormat) else { return nil }
        // App audio is stereo: mix both sides instead of keeping the left.
        converter.downmix = true
        converters[source] = converter
        return converter
    }

    private static func swapBytes(_ buffer: AVAudioPCMBuffer, bits: Int) {
        for audioBuffer in UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList) {
            guard let data = audioBuffer.mData else { continue }
            let bytes = Int(audioBuffer.mDataByteSize)
            switch bits {
            case 16:
                let samples = data.bindMemory(to: UInt16.self, capacity: bytes / 2)
                for i in 0..<(bytes / 2) { samples[i] = samples[i].byteSwapped }
            case 32:
                let samples = data.bindMemory(to: UInt32.self, capacity: bytes / 4)
                for i in 0..<(bytes / 4) { samples[i] = samples[i].byteSwapped }
            default:
                break
            }
        }
    }

    /// Every 10 ms: the mix so far, or silence, so the Opus stream never
    /// stalls when nothing is playing.
    private func deliver() {
        guard isRecording, let delegate else { return }
        var samples = [Int16](repeating: 0, count: Self.chunk)
        samples.withUnsafeMutableBufferPointer { mixer.pull(into: $0) }
        var flags = AudioUnitRenderActionFlags()
        var timestamp = AudioTimeStamp()
        timestamp.mSampleTime = sampleTime
        timestamp.mHostTime = mach_absolute_time()
        timestamp.mFlags = [.sampleTimeValid, .hostTimeValid]
        sampleTime += Double(Self.chunk)
        samples.withUnsafeMutableBytes { raw in
            var list = AudioBufferList(
                mNumberBuffers: 1,
                mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(raw.count), mData: raw.baseAddress)
            )
            _ = delegate.deliverRecordedData(&flags, &timestamp, 1, UInt32(Self.chunk), &list, nil, nil)
        }
    }
}
