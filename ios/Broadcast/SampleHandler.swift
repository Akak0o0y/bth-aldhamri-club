// The Broadcast Upload Extension's entry point. iOS starts this process when
// the streamer picks "بث الضمري" in the broadcast picker or Control Center,
// hands it every screen frame and audio buffer, and ends it on Stop. It runs
// under a ~50 MB memory limit, so frames are scaled down before WebRTC sees
// them and nothing is kept that isn't needed.
import ReplayKit
import DhamriCore

final class SampleHandler: RPBroadcastSampleHandler {
    private var session: BroadcastSession?

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        guard let streamer = SharedStore.loadSession(), !streamer.token.isEmpty else {
            SharedStore.status = BroadcastStatus(state: .error, message: BroadcastFailure.signedOut.message)
            finishBroadcastWithError(BroadcastFailure.signedOut.error)
            return
        }
        let session = BroadcastSession(
            streamer: streamer,
            settings: SharedStore.settings,
            channel: Channel(server: SharedStore.mediaServer, room: streamer.room ?? ""),
            relay: SharedStore.relayServer
        )
        // Reported from the publisher's queue; ending the broadcast calls back
        // into stop(), which waits on that queue.
        session.onFatal = { [weak self] failure in
            DispatchQueue.main.async { self?.finishBroadcastWithError(failure.error) }
        }
        self.session = session
        session.start()
    }

    override func broadcastPaused() {
        session?.pause()
    }

    override func broadcastResumed() {
        session?.resume()
    }

    override func broadcastFinished() {
        session?.stop()
        session = nil
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        switch sampleBufferType {
        case .video: session?.video(sampleBuffer)
        case .audioApp: session?.audio(sampleBuffer, from: .app)
        case .audioMic: session?.audio(sampleBuffer, from: .mic)
        @unknown default: break
        }
    }
}

/// Reasons a broadcast ends on its own. iOS shows the message in its alert.
enum BroadcastFailure {
    case signedOut
    case unauthorized

    var message: String {
        switch self {
        case .signedOut: return "سجّل الدخول في تطبيق بث الضمري أولاً"
        case .unauthorized: return "الحساب غير مقبول أو انتهت الجلسة — سجّل الدخول من جديد"
        }
    }

    var error: NSError {
        NSError(domain: "Dhamri.Broadcast", code: self == .signedOut ? 1 : 2, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
