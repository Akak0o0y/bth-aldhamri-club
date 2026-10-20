// The "be right back" notice while ReplayKit has the broadcast paused. A
// socket joins the channel's relay room as its host and sends the hold; it
// stays open (the relay ends a hold two minutes after its socket drops) and
// says it again after a reconnect. Relays without the hold feature ignore the
// message, and viewers simply keep the last frame.
import Foundation
import DhamriCore

final class HoldNotifier: NSObject, URLSessionWebSocketDelegate {
    private let socket: URL
    private let room: String
    private let name: String
    private let voter: String
    private let token: String
    private let since = Date()
    private let queue = DispatchQueue(label: "dhamri.hold")
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var finished = false

    init(socket: URL, room: String, name: String, voter: String, token: String) {
        self.socket = socket
        self.room = room
        self.name = name
        self.voter = voter
        self.token = token
        super.init()
    }

    func start() {
        queue.async { self.connect() }
    }

    /// Lifts the hold: `broadcastEnded` says the broadcast stopped rather than
    /// came back, so viewers aren't told "back on air". Waits up to `wait`
    /// seconds for the message to leave.
    func end(broadcastEnded: Bool, wait: TimeInterval = 0) {
        let done = DispatchSemaphore(value: 0)
        queue.async {
            self.finished = true
            guard let task = self.task else {
                // Between reconnects: nothing to say, but the session still
                // holds on to us until it is invalidated.
                self.session?.invalidateAndCancel()
                self.session = nil
                done.signal()
                return
            }
            self.task = nil
            task.send(.string(RelayMessage.holdEnd(ended: broadcastEnded, token: self.token))) { _ in
                task.cancel(with: .normalClosure, reason: nil)
                self.session?.finishTasksAndInvalidate()
                done.signal()
            }
        }
        if wait > 0 { _ = done.wait(timeout: .now() + wait) }
    }

    // MARK: - Socket (on `queue`)

    private func connect() {
        guard !finished else { return }
        if session == nil {
            let operations = OperationQueue()
            operations.underlyingQueue = queue
            session = URLSession(configuration: .default, delegate: self, delegateQueue: operations)
        }
        guard let session else { return }
        let task = session.webSocketTask(with: socket)
        self.task = task
        task.resume()
        // The relay ignores everything until hello has joined the room.
        let elapsed = Int(Date().timeIntervalSince(since) * 1000)
        task.send(.string(RelayMessage.hello(room: room, id: RandomID.make(), voter: voter, name: name))) { _ in }
        task.send(.string(RelayMessage.holdStart(elapsedMs: elapsed, note: "", token: token))) { _ in }
        listen(task)
    }

    // Reading keeps the socket's state current (the relay sends the room's
    // chat and presence); the content isn't needed here.
    private func listen(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard task === self.task else { return }
                switch result {
                case .success: self.listen(task)
                case .failure: self.reconnectSoon()
                }
            }
        }
    }

    private func reconnectSoon() {
        guard !finished else { return }
        task = nil
        queue.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.task == nil else { return }
            self.connect()
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        if webSocketTask === task { reconnectSoon() }
    }
}
