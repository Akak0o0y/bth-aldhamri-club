// One broadcast, from Start to Stop: a send-only WebRTC setup (H.264 from the
// hardware encoder, Opus fed by ReplayKit's audio), the WHIP publisher, and
// the hold notice while ReplayKit has the broadcast paused.
import CoreMedia
import WebRTC
import DhamriCore

final class BroadcastSession {
    var onFatal: ((BroadcastFailure) -> Void)?

    private let streamer: StreamerSession
    private let settings: BroadcastSettings
    private let channel: Channel
    private let relay: URL
    private let audioDevice: ReplayKitAudioDevice
    private let factory: RTCPeerConnectionFactory
    private let screen: ScreenVideoSource
    private let videoTrack: RTCVideoTrack
    private let audioTrack: RTCAudioTrack
    private let lock = NSLock()
    private var publisher: WhipPublisher?
    private var hold: HoldNotifier?
    private var heartbeat: DispatchSourceTimer?
    private var lastStatus = BroadcastStatus(state: .connecting)

    private static let setUp: Void = {
        _ = RTCInitializeSSL()
        RTCSetMinDebugLogLevel(.warning)
    }()

    init(streamer: StreamerSession, settings: BroadcastSettings, channel: Channel, relay: URL) {
        _ = BroadcastSession.setUp
        self.streamer = streamer
        self.settings = settings
        self.channel = channel
        self.relay = relay

        // Only the H.264 factories: the offer then carries H.264 alone (what
        // the studio prefers too), and no software VP8/VP9/AV1 encoder is ever
        // loaded into the extension's small memory budget.
        let audioDevice = ReplayKitAudioDevice()
        let factory = RTCPeerConnectionFactory(
            encoderFactory: RTCVideoEncoderFactoryH264(),
            decoderFactory: RTCVideoDecoderFactoryH264(),
            audioDevice: audioDevice
        )
        let videoSource = factory.videoSource(forScreenCast: true)
        // App audio is not a voice: no echo cancelling, gain riding or noise
        // gate (the studio turns these off for screen audio too).
        let audioSource = factory.audioSource(with: RTCMediaConstraints(
            mandatoryConstraints: [
                "googEchoCancellation": "false",
                "googAutoGainControl": "false",
                "googNoiseSuppression": "false",
                "googHighpassFilter": "false",
            ],
            optionalConstraints: nil
        ))
        self.audioDevice = audioDevice
        self.factory = factory
        self.screen = ScreenVideoSource(source: videoSource, preset: settings.preset, fps: settings.fps)
        self.videoTrack = factory.videoTrack(with: videoSource, trackId: "screen")
        self.audioTrack = factory.audioTrack(with: audioSource, trackId: "audio")
    }

    func start() {
        // One id for the whole broadcast, reconnects included: the relay starts
        // the channel's chat over only when it changes.
        let publisher = WhipPublisher(
            factory: factory,
            client: WhipClient(endpoint: channel.whipURL(session: RandomID.make()), token: streamer.token),
            video: videoTrack,
            audio: audioTrack,
            settings: settings
        )
        publisher.onStatus = { [weak self] state, message in
            self?.report(state, message)
        }
        publisher.onUnauthorized = { [weak self] in
            // Same as the site: a refused token signs this device out.
            SharedStore.clearSession()
            self?.report(.error, BroadcastFailure.unauthorized.message)
            self?.onFatal?(.unauthorized)
        }
        lock.withLock { self.publisher = publisher }
        report(.connecting, "")
        screen.start()
        publisher.start()
        startHeartbeat()
    }

    func video(_ sampleBuffer: CMSampleBuffer) {
        screen.push(sampleBuffer)
    }

    func audio(_ sampleBuffer: CMSampleBuffer, from source: AudioMixer.Source) {
        audioDevice.push(sampleBuffer, from: source)
    }

    /// ReplayKit paused the broadcast: viewers keep the last frame, and the
    /// relay shows them the hold card with its timer.
    func pause() {
        let notifier = HoldNotifier(
            socket: Servers.socketURL(relay: relay),
            room: channel.room,
            name: streamer.name,
            voter: SharedStore.deviceID,
            token: streamer.token
        )
        lock.withLock {
            hold?.end(broadcastEnded: false)
            hold = notifier
        }
        notifier.start()
        report(.paused, "")
    }

    func resume() {
        let notifier = lock.withLock { () -> HoldNotifier? in
            defer { hold = nil }
            return hold
        }
        notifier?.end(broadcastEnded: false)
        report(.live, "")
    }

    func stop() {
        heartbeat?.cancel()
        heartbeat = nil
        let (notifier, publisher) = lock.withLock { () -> (HoldNotifier?, WhipPublisher?) in
            defer {
                hold = nil
                self.publisher = nil
            }
            return (hold, self.publisher)
        }
        // Ending mid-hold is not "back on air"; give both goodbyes a moment
        // to leave before iOS ends the process.
        notifier?.end(broadcastEnded: true, wait: 1)
        screen.stop()
        publisher?.stop(wait: 1.5)
        SharedStore.status = BroadcastStatus(state: .idle)
    }

    private func report(_ state: BroadcastStatus.State, _ message: String) {
        let status = lock.withLock { () -> BroadcastStatus in
            // While paused the publisher still reports its connection; keep
            // showing "paused" until ReplayKit resumes.
            let shown = hold != nil && state == .live ? BroadcastStatus.State.paused : state
            lastStatus = BroadcastStatus(state: shown, message: message)
            return lastStatus
        }
        SharedStore.status = status
    }

    /// Lets the app tell a running broadcast from one iOS killed (memory,
    /// crash) without saying goodbye.
    private func startHeartbeat() {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 3, repeating: 3)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            var status = self.lock.withLock { self.lastStatus }
            status.updated = Date()
            SharedStore.status = status
        }
        timer.resume()
        heartbeat = timer
    }
}
