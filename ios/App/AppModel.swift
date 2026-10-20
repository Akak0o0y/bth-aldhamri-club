import Foundation
import DhamriCore

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var session = SharedStore.loadSession()
    @Published private(set) var status = SharedStore.status
    @Published var settings = SharedStore.settings {
        didSet { SharedStore.settings = settings }
    }
    @Published private(set) var busy = false
    @Published var error: String?

    private var watcher: Timer?

    private var relay: RelayAPI { RelayAPI(base: SharedStore.relayServer) }

    /// The streamer's own channel: where they broadcast and what they share.
    var channel: Channel? {
        session.map { Channel(server: SharedStore.mediaServer, room: $0.room ?? "") }
    }

    func login(name: String, pass: String) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let session = try await relay.login(name: name, pass: pass)
            guard SharedStore.saveSession(session) else {
                error = "تعذر حفظ الجلسة على الجهاز"
                return
            }
            self.session = session
        } catch {
            self.error = error.localizedDescription
        }
    }

    func signOut() {
        SharedStore.clearSession()
        session = nil
    }

    /// Like checkSession() on the site: drops a token the relay no longer
    /// accepts and refreshes the channel; a network failure keeps it.
    func refresh() async {
        guard let current = session else { return }
        do {
            let account = try await relay.me(token: current.token)
            guard session?.token == current.token else { return }
            var updated = current
            updated.owner = account.owner
            updated.room = account.room
            if updated != current, SharedStore.saveSession(updated) { session = updated }
        } catch RelayError.session {
            signOut()
        } catch {
            // Offline: keep the session; the broadcast will say if it's refused.
        }
    }

    /// The extension may have signed out (a refused token) or changed the
    /// status while the app was in the background.
    func reload() {
        session = SharedStore.loadSession()
        status = SharedStore.status
    }

    func startWatching() {
        guard watcher == nil else { return }
        watcher = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                let next = SharedStore.status
                if next != self.status { self.status = next }
                if self.session != nil, SharedStore.loadSession() == nil { self.session = nil }
            }
        }
    }
}
