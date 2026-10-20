// The two HTTP APIs a broadcast talks to: WHIP on MediaMTX (same calls as
// src/stream/whip.js) and the accounts API on the realtime relay (same calls
// as src/auth/session.js). Completion handlers rather than async/await so the
// extension can keep every step on one serial queue.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - WHIP

public enum WhipError: Error, Equatable {
    /// No answer from the media server (offline, DNS, TLS...).
    case unreachable
    /// Missing, expired or wrong session token; retrying can't fix it.
    case unauthorized
    /// The server answered with an error status.
    case rejected(status: Int, detail: String)
}

public struct WhipAnswer: Equatable, Sendable {
    public let sdp: String
    /// The session resource from the Location header: trickle ICE goes there
    /// as PATCH, and DELETE ends the publish.
    public let resource: URL?
}

public final class WhipClient {
    public let endpoint: URL
    private let token: String
    private let session: URLSession

    public init(endpoint: URL, token: String, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.token = token
        self.session = session
    }

    private func makeRequest(_ url: URL, method: String, contentType: String? = nil, body: String? = nil) -> URLRequest {
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method
        request.setValue(SDP.authorization(token: token), forHTTPHeaderField: "Authorization")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let body { request.httpBody = Data(body.utf8) }
        return request
    }

    /// OPTIONS: the ICE servers MediaMTX advertises, or public STUN. Any HTTP
    /// answer counts; only a network failure is an error.
    public func iceServers(completion: @escaping (Result<[IceServer], WhipError>) -> Void) {
        session.dataTask(with: makeRequest(endpoint, method: "OPTIONS")) { _, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else { return completion(.failure(.unreachable)) }
            completion(.success(SDP.iceServers(fromLink: http.value(forHTTPHeaderField: "Link")) ?? SDP.fallbackIceServers))
        }.resume()
    }

    /// POST the offer; the body of a 201 is the answer.
    public func publish(offer: String, completion: @escaping (Result<WhipAnswer, WhipError>) -> Void) {
        let request = makeRequest(endpoint, method: "POST", contentType: "application/sdp", body: offer)
        session.dataTask(with: request) { [endpoint] data, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else { return completion(.failure(.unreachable)) }
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            completion(WhipClient.interpret(status: http.statusCode, body: body, location: http.value(forHTTPHeaderField: "Location"), endpoint: endpoint))
        }.resume()
    }

    /// The POST outcome, separate from the network so it can be tested.
    public static func interpret(status: Int, body: String, location: String?, endpoint: URL) -> Result<WhipAnswer, WhipError> {
        if status == 401 || status == 403 { return .failure(.unauthorized) }
        guard (200..<300).contains(status) else { return .failure(.rejected(status: status, detail: errorDetail(body))) }
        let resource = location.flatMap { URL(string: $0, relativeTo: endpoint)?.absoluteURL }
        return .success(WhipAnswer(sdp: body, resource: resource))
    }

    // MediaMTX answers errors as {"error": "..."}; anything else is shown as is.
    static func errorDetail(_ body: String) -> String {
        struct Body: Decodable { let error: String? }
        if let parsed = try? JSONDecoder().decode(Body.self, from: Data(body.utf8)), let error = parsed.error { return error }
        return body.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Trickle ICE: candidates found after the offer went out.
    public func sendCandidates(_ fragment: String, to resource: URL) {
        var request = makeRequest(resource, method: "PATCH", contentType: "application/trickle-ice-sdpfrag", body: fragment)
        request.setValue("*", forHTTPHeaderField: "If-Match")
        session.dataTask(with: request).resume()
    }

    /// Ends the publish so viewers see the channel go offline at once.
    public func end(_ resource: URL, completion: (() -> Void)? = nil) {
        session.dataTask(with: makeRequest(resource, method: "DELETE")) { _, _, _ in completion?() }.resume()
    }
}

// MARK: - Accounts

/// A signed-in streamer, as /api/login returns it. `room` is their channel.
public struct StreamerSession: Codable, Equatable, Sendable {
    public var name: String
    public var owner: Bool
    public var room: String?
    public var token: String

    public init(name: String, owner: Bool, room: String?, token: String) {
        self.name = name
        self.owner = owner
        self.room = room
        self.token = token
    }
}

/// What /api/me says about a token that is still good.
public struct Account: Codable, Equatable, Sendable {
    public var name: String
    public var owner: Bool
    public var room: String?
}

public enum RelayError: Error, Equatable, LocalizedError {
    case unreachable
    case login
    case busy
    case session
    case status(Int)

    /// The site's own wording (ERRORS in src/auth/session.js).
    public var errorDescription: String? {
        switch self {
        case .unreachable: return "تعذر الوصول إلى السيرفر — تحقق من الاتصال"
        case .login: return "اسم المستخدم أو كلمة المرور غير صحيحة"
        case .busy: return "محاولات كثيرة — انتظر عشر دقائق ثم حاول مجدداً"
        case .session: return "انتهت الجلسة — سجّل الدخول من جديد"
        case let .status(code): return "رد السيرفر بالحالة \(code)"
        }
    }

    static func from(status: Int, body: Data?) -> RelayError {
        struct Body: Decodable { let error: String? }
        switch body.flatMap({ try? JSONDecoder().decode(Body.self, from: $0) })?.error {
        case "login": return .login
        case "busy": return .busy
        case "session": return .session
        default: return .status(status)
        }
    }
}

public final class RelayAPI {
    public let base: URL
    private let session: URLSession

    public init(base: URL = Servers.relay, session: URLSession = .shared) {
        self.base = base
        self.session = session
    }

    private func call<T: Decodable>(_ path: String, body: [String: String]? = nil, token: String? = nil,
                                    completion: @escaping (Result<T, RelayError>) -> Void) {
        var request = URLRequest(url: base.appendingPathComponent(path), timeoutInterval: 20)
        request.httpMethod = body == nil ? "GET" : "POST"
        if let token { request.setValue(SDP.authorization(token: token), forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONEncoder().encode(body)
        }
        session.dataTask(with: request) { data, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else { return completion(.failure(.unreachable)) }
            guard (200..<300).contains(http.statusCode) else {
                return completion(.failure(RelayError.from(status: http.statusCode, body: data)))
            }
            guard let data, let value = try? JSONDecoder().decode(T.self, from: data) else {
                return completion(.failure(.status(http.statusCode)))
            }
            completion(.success(value))
        }.resume()
    }

    public func login(name: String, pass: String, completion: @escaping (Result<StreamerSession, RelayError>) -> Void) {
        call("api/login", body: ["name": name.trimmingCharacters(in: .whitespacesAndNewlines), "pass": pass], completion: completion)
    }

    /// Refreshes the channel and owner flag; `.session` means the token is no
    /// longer accepted (expired, password changed, account removed).
    public func me(token: String, completion: @escaping (Result<Account, RelayError>) -> Void) {
        call("api/me", token: token, completion: completion)
    }

    public func login(name: String, pass: String) async throws -> StreamerSession {
        try await withCheckedThrowingContinuation { continuation in
            login(name: name, pass: pass) { continuation.resume(with: $0) }
        }
    }

    public func me(token: String) async throws -> Account {
        try await withCheckedThrowingContinuation { continuation in
            me(token: token) { continuation.resume(with: $0) }
        }
    }
}
