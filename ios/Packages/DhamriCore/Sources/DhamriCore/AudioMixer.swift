// ReplayKit hands the broadcast two separate audio streams — what the apps
// play and the microphone — each on its own schedule. They are converted to
// 48 kHz mono Int16 and queued here; WebRTC's audio device pulls fixed 10 ms
// chunks with both mixed in, and silence when neither has anything.
import Foundation

public final class AudioMixer {
    public enum Source: Int, CaseIterable {
        case app
        case mic
    }

    /// Samples kept per source before the oldest are dropped, which bounds
    /// the delay a source can build up when it runs slightly fast.
    public let maxBuffered: Int
    private var queues: [[Int16]] = Array(repeating: [], count: Source.allCases.count)
    private let lock = NSLock()

    public init(maxBuffered: Int = 9_600) {
        self.maxBuffered = maxBuffered
    }

    public func push(_ samples: UnsafeBufferPointer<Int16>, from source: Source) {
        guard !samples.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        queues[source.rawValue].append(contentsOf: samples)
        let extra = queues[source.rawValue].count - maxBuffered
        if extra > 0 { queues[source.rawValue].removeFirst(extra) }
    }

    public func push(_ samples: [Int16], from source: Source) {
        samples.withUnsafeBufferPointer { push($0, from: source) }
    }

    /// Fills `out` with the mix of everything queued (saturating, so loud
    /// app audio plus speech clips instead of wrapping around).
    public func pull(into out: UnsafeMutableBufferPointer<Int16>) {
        var mix = [Int32](repeating: 0, count: out.count)
        lock.lock()
        for index in queues.indices {
            let take = min(out.count, queues[index].count)
            guard take > 0 else { continue }
            for i in 0..<take { mix[i] += Int32(queues[index][i]) }
            queues[index].removeFirst(take)
        }
        lock.unlock()
        for i in 0..<out.count { out[i] = Int16(clamping: mix[i]) }
    }

    public func pull(count: Int) -> [Int16] {
        var out = [Int16](repeating: 0, count: count)
        out.withUnsafeMutableBufferPointer { pull(into: $0) }
        return out
    }

    public func buffered(_ source: Source) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return queues[source.rawValue].count
    }

    public func reset() {
        lock.lock()
        queues = Array(repeating: [], count: Source.allCases.count)
        lock.unlock()
    }
}
