// macOS/iOS URLSession client for the Maco Worker. The CLI at the end is a macOS example.
// swiftc -parse-as-library examples/MacoClient.swift -o /tmp/maco-client
// Supply MACO_URL and MACO_TOKEN (the signed-in user's bearer token) through the environment.
// /tmp/maco-client snapshot
// /tmp/maco-client watch 0
// /tmp/maco-client command task.json
//
// Persist a command, including commandId, before submission. Use the same file when retrying.
// {"protocolVersion":1,"commandId":"client-a-1","type":"task.create","message":"Find my invoices",
//  "modelProfile":{"provider":"openai","model":"gpt-5","connectionId":"MODEL_ID"},"mailboxId":"MAIL_ID"}
// {"protocolVersion":1,"commandId":"client-a-2","type":"task.steer","taskId":"TASK_ID","taskVersion":1,"message":"Only last week"}
// {"protocolVersion":1,"commandId":"client-a-3","type":"mail.approve","operationId":"OP_ID","approvalVersion":1}
// Approve only after displaying the server's frozen preview and receiving the user's confirmation.

import Foundation

private enum ClientError: Error, CustomStringConvertible {
    case invalid(String)
    case http(Int)
    case sequenceGap

    var description: String {
        switch self {
        case .invalid(let message): return message
        case .http(let status): return "HTTP \(status)"
        case .sequenceGap: return "Missing event sequence"
        }
    }
}

private func object(_ data: Data) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw ClientError.invalid("Expected a JSON object")
    }
    return value
}

struct MacoClient: Sendable {
    let baseURL: URL
    let token: String

    init(baseURL: URL, token: String) throws {
        let local = ["localhost", "127.0.0.1", "[::1]"].contains(baseURL.host)
        guard baseURL.scheme == "https" || (local && baseURL.scheme == "http"),
              baseURL.host != nil, baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil, !token.isEmpty else {
            throw ClientError.invalid("MACO_URL requires an HTTPS origin or local development URL, and MACO_TOKEN is required")
        }
        self.baseURL = baseURL
        self.token = token
    }

    private func request(_ endpoint: String, after: Int64? = nil, socket: Bool = false) throws -> URLRequest {
        guard var url = URLComponents(url: baseURL.appendingPathComponent("v1/" + endpoint), resolvingAgainstBaseURL: false) else {
            throw ClientError.invalid("Invalid URL")
        }
        if let after { url.queryItems = [URLQueryItem(name: "after", value: String(after))] }
        if socket { url.scheme = baseURL.scheme == "https" ? "wss" : "ws" }
        guard let finalURL = url.url else { throw ClientError.invalid("Invalid endpoint") }
        var request = URLRequest(url: finalURL)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        return request
    }

    private func fetch(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalid("Expected HTTP") }
        guard (200..<300).contains(http.statusCode) else { throw ClientError.http(http.statusCode) }
        return data
    }

    func snapshot() async throws -> Data {
        try await fetch(request("snapshot"))
    }

    func submit(_ command: Data) async throws -> Data {
        let envelope = try object(command)
        guard envelope["protocolVersion"] as? Int == 1,
              let id = envelope["commandId"] as? String, !id.isEmpty else {
            throw ClientError.invalid("Persist protocolVersion and commandId before submitting")
        }
        var outgoing = try request("commands")
        outgoing.httpMethod = "POST"
        outgoing.httpBody = command
        outgoing.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await fetch(outgoing)
    }

    // The caller commits its projection and this event's seq in the same local transaction.
    // A new device may apply snapshot() and start at its snapshotCursor.
    func watch(after initial: Int64, apply: @Sendable (Data, Int64) throws -> Void) async throws {
        var cursor = initial
        var delay = 1
        func commit(_ event: Data) throws {
            let value = try object(event)
            guard let seq = value["seq"] as? Int64 else { throw ClientError.invalid("Event missing seq") }
            if seq <= cursor { return }
            guard seq == cursor + 1 else { throw ClientError.sequenceGap }
            try apply(event, seq)
            cursor = seq
        }
        while !Task.isCancelled {
            do {
                // Resume durable replay first. after=cursor also closes the race between GET and WS upgrade.
                var hasMore = true
                while hasMore {
                    let page = try object(await fetch(request("events", after: cursor)))
                    guard let events = page["events"] as? [[String: Any]],
                          let more = page["hasMore"] as? Bool, !more || !events.isEmpty else {
                        throw ClientError.invalid("Invalid event page")
                    }
                    for event in events { try commit(JSONSerialization.data(withJSONObject: event)) }
                    hasMore = more
                }
                let socket = URLSession.shared.webSocketTask(with: try request("socket", after: cursor, socket: true))
                socket.resume()
                defer { socket.cancel(with: .goingAway, reason: nil) }
                while !Task.isCancelled {
                    let frame = try await withTaskCancellationHandler {
                        try await socket.receive()
                    } onCancel: {
                        socket.cancel(with: .goingAway, reason: nil)
                    }
                    let data: Data
                    switch frame {
                    case .data(let bytes): data = bytes
                    case .string(let text): data = Data(text.utf8)
                    @unknown default: throw ClientError.invalid("Unsupported WebSocket message")
                    }
                    try commit(data)
                    delay = 1
                    try await socket.send(.string("{\"type\":\"ack\",\"seq\":\(cursor)}"))
                }
            } catch ClientError.http(let status) where (400..<500).contains(status) && status != 429 {
                throw ClientError.http(status)
            } catch ClientError.invalid(let explanation) {
                throw ClientError.invalid(explanation)
            } catch {
                try Task.checkCancellation()
                try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000_000)
                delay = min(delay * 2, 30)
            }
        }
    }
}

#if os(macOS)
@main
enum Example {
    static func main() async {
        do {
            let env = ProcessInfo.processInfo.environment
            guard let baseURL = URL(string: env["MACO_URL"] ?? ""),
                  let token = env["MACO_TOKEN"] else { throw ClientError.invalid("Set MACO_URL and MACO_TOKEN") }
            let client = try MacoClient(baseURL: baseURL, token: token)
            let args = Array(CommandLine.arguments.dropFirst())
            switch args.first {
            case "snapshot" where args.count == 1:
                print(String(decoding: try await client.snapshot(), as: UTF8.self))
            case "command" where args.count == 2:
                let data = try Data(contentsOf: URL(fileURLWithPath: args[1]))
                print(String(decoding: try await client.submit(data), as: UTF8.self))
            case "watch" where args.count == 2:
                guard let cursor = Int64(args[1]), cursor >= 0 else { throw ClientError.invalid("Invalid cursor") }
                try await client.watch(after: cursor) { data, _ in print(String(decoding: data, as: UTF8.self)) }
            default:
                throw ClientError.invalid("Usage: maco-client snapshot | command <json-file> | watch <after-seq>")
            }
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(EXIT_FAILURE)
        }
    }
}
#endif
