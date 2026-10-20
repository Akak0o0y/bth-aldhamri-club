// WHIP publisher: the same steps as src/stream/whip.js, on libwebrtc's iOS
// API. OPTIONS for ICE servers, POST the offer with the streamer's session as
// Bearer, PATCH late candidates, DELETE on stop; reconnect on failure with the
// same session id, and give up only when the token is refused. Every state
// change happens on one serial queue.
import Foundation
import WebRTC
import DhamriCore

final class WhipPublisher: NSObject {
    var onStatus: ((BroadcastStatus.State, String) -> Void)?
    var onUnauthorized: (() -> Void)?

    private let factory: RTCPeerConnectionFactory
    private let client: WhipClient
    private let video: RTCVideoTrack
    private let audio: RTCAudioTrack
    private let settings: BroadcastSettings
    private let queue = DispatchQueue(label: "dhamri.whip")

    private var pc: RTCPeerConnection?
    private var videoSender: RTCRtpSender?
    private var resource: URL?
    private var offer: OfferInfo?
    private var pending: [LocalCandidate] = []
    private var generation = 0
    private var stopped = true
    private var retry: DispatchWorkItem?

    init(factory: RTCPeerConnectionFactory, client: WhipClient, video: RTCVideoTrack, audio: RTCAudioTrack, settings: BroadcastSettings) {
        self.factory = factory
        self.client = client
        self.video = video
        self.audio = audio
        self.settings = settings
    }

    func start() {
        queue.async {
            self.stopped = false
            self.connect()
        }
    }

    /// Closes the connection and waits up to `wait` seconds for the DELETE,
    /// so viewers see the channel end at once instead of timing out.
    func stop(wait: TimeInterval) {
        let ended = queue.sync { () -> URL? in
            stopped = true
            let resource = self.resource
            self.resource = nil
            teardown()
            return resource
        }
        guard let resource = ended else { return }
        let done = DispatchSemaphore(value: 0)
        client.end(resource) { done.signal() }
        _ = done.wait(timeout: .now() + wait)
    }

    // MARK: - Connection (on `queue`)

    private func live(_ generation: Int) -> Bool {
        generation == self.generation && !stopped
    }

    private func report(_ state: BroadcastStatus.State, _ message: String = "") {
        if !stopped { onStatus?(state, message) }
    }

    private func teardown() {
        generation += 1
        retry?.cancel()
        retry = nil
        if let pc {
            pc.delegate = nil
            pc.close()
        }
        pc = nil
        videoSender = nil
        if let resource { client.end(resource) }
        resource = nil
        offer = nil
        pending = []
    }

    private func scheduleRetry(_ state: BroadcastStatus.State, _ message: String, after delay: TimeInterval) {
        teardown()
        report(state, message)
        guard !stopped else { return }
        let work = DispatchWorkItem { [weak self] in self?.connect() }
        retry = work
        queue.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func connect() {
        teardown()
        let generation = self.generation
        report(.connecting)
        client.iceServers { [weak self] result in
            self?.queue.async {
                guard let self, self.live(generation) else { return }
                switch result {
                case let .success(servers):
                    self.open(iceServers: servers, generation)
                case .failure:
                    self.scheduleRetry(.error, "تعذر الوصول إلى سيرفر البث", after: 5)
                }
            }
        }
    }

    private func open(iceServers: [IceServer], _ generation: Int) {
        let config = RTCConfiguration()
        config.iceServers = iceServers.map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
        config.bundlePolicy = .maxBundle
        config.rtcpMuxPolicy = .require
        // MediaMTX also listens on TCP 8189 for networks that block UDP.
        config.tcpCandidatePolicy = .enabled
        config.continualGatheringPolicy = .gatherOnce

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            return scheduleRetry(.error, "تعذر تجهيز الاتصال", after: 4)
        }
        self.pc = pc

        let videoInit = RTCRtpTransceiverInit()
        videoInit.direction = .sendOnly
        videoInit.streamIds = ["dhamri"]
        let videoEncoding = RTCRtpEncodingParameters()
        videoEncoding.isActive = true
        videoEncoding.maxBitrateBps = NSNumber(value: settings.videoKbps * 1000)
        videoEncoding.maxFramerate = NSNumber(value: settings.fps)
        videoInit.sendEncodings = [videoEncoding]
        videoSender = pc.addTransceiver(with: video, init: videoInit)?.sender

        let audioInit = RTCRtpTransceiverInit()
        audioInit.direction = .sendOnly
        audioInit.streamIds = ["dhamri"]
        let audioEncoding = RTCRtpEncodingParameters()
        audioEncoding.isActive = true
        audioEncoding.maxBitrateBps = NSNumber(value: settings.audioKbps * 1000)
        audioInit.sendEncodings = [audioEncoding]
        _ = pc.addTransceiver(with: audio, init: audioInit)

        pc.offer(for: constraints) { [weak self] description, error in
            self?.queue.async {
                guard let self, self.live(generation) else { return }
                guard let description else {
                    return self.scheduleRetry(.error, error?.localizedDescription ?? "تعذر تجهيز العرض", after: 4)
                }
                pc.setLocalDescription(description) { [weak self] error in
                    self?.queue.async {
                        guard let self, self.live(generation) else { return }
                        if let error { return self.scheduleRetry(.error, error.localizedDescription, after: 4) }
                        self.post(offer: description.sdp, pc: pc, generation)
                    }
                }
            }
        }
    }

    private func post(offer sdp: String, pc: RTCPeerConnection, _ generation: Int) {
        offer = SDP.parseOffer(sdp)
        client.publish(offer: SDP.tunePublisherOffer(sdp, settings.tuning)) { [weak self] result in
            self?.queue.async {
                guard let self, self.live(generation) else { return }
                switch result {
                case .failure(.unauthorized):
                    // A missing or refused token: retrying can't fix that.
                    self.stopped = true
                    self.teardown()
                    self.onUnauthorized?()
                case .failure(.unreachable):
                    self.scheduleRetry(.error, "انقطع الاتصال بسيرفر البث", after: 4)
                case let .failure(.rejected(status, detail)):
                    self.scheduleRetry(.error, "رفض السيرفر البث (\(status)) \(detail)", after: 4)
                case let .success(answer):
                    self.resource = answer.resource
                    let remote = RTCSessionDescription(type: .answer, sdp: SDP.tunePublisherAnswer(answer.sdp, self.settings.tuning))
                    pc.setRemoteDescription(remote) { [weak self] error in
                        self?.queue.async {
                            guard let self, self.live(generation) else { return }
                            if let error { return self.scheduleRetry(.error, error.localizedDescription, after: 4) }
                            if !self.pending.isEmpty {
                                self.sendCandidates(self.pending)
                                self.pending = []
                            }
                            self.applyEncoding()
                        }
                    }
                }
            }
        }
    }

    private func sendCandidates(_ candidates: [LocalCandidate]) {
        guard let resource, let offer else { return }
        client.sendCandidates(SDP.fragment(offer: offer, candidates: candidates), to: resource)
    }

    /// What gives way when the network or encoder can't keep up is the
    /// streamer's choice, as in the studio: text keeps its resolution, games
    /// keep their frame rate.
    private func applyEncoding() {
        guard let sender = videoSender else { return }
        let parameters = sender.parameters
        for encoding in parameters.encodings {
            encoding.maxBitrateBps = NSNumber(value: settings.videoKbps * 1000)
            encoding.maxFramerate = NSNumber(value: settings.fps)
        }
        let preference: RTCDegradationPreference = settings.hint == .motion ? .maintainFramerate : .maintainResolution
        parameters.degradationPreference = NSNumber(value: preference.rawValue)
        sender.parameters = parameters
    }

    fileprivate func connectionChanged(_ state: RTCPeerConnectionState, on peer: RTCPeerConnection) {
        guard peer === pc, !stopped else { return }
        switch state {
        case .connected:
            report(.live)
        case .disconnected:
            report(.reconnecting)
        case .failed, .closed:
            scheduleRetry(.reconnecting, "انقطع الاتصال بالسيرفر، جارٍ إعادة البث", after: 1.5)
        default:
            break
        }
    }

    fileprivate func found(_ candidate: LocalCandidate, on peer: RTCPeerConnection) {
        guard peer === pc else { return }
        if resource != nil { sendCandidates([candidate]) } else { pending.append(candidate) }
    }
}

// libwebrtc calls these on its signaling thread; hop onto our queue.
extension WhipPublisher: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        queue.async { self.connectionChanged(newState, on: peerConnection) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let local = LocalCandidate(mLineIndex: Int(candidate.sdpMLineIndex), line: candidate.sdp)
        queue.async { self.found(local, on: peerConnection) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
