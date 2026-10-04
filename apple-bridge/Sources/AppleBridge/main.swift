import Foundation
import Network

// ClearTrace Apple bridge: serves Apple's on-device Foundation Model over an
// Ollama-compatible API (GET /api/tags, POST /api/chat) on loopback only, so the
// ClearTrace server can polish drafts without personal data leaving this Mac.

setvbuf(stdout, nil, _IOLBF, 0)  // line-buffer so logs show up under launchd / background runs

let env = ProcessInfo.processInfo.environment
let port = UInt16(env["APPLE_BRIDGE_PORT"] ?? "") ?? 11435
let token = env["APPLE_BRIDGE_TOKEN"]

func route(_ request: HTTPRequest) async -> HTTPResponse {
    if let (status, message) = RequestGuard.refusal(for: request, port: port, token: token) {
        return .error(status, message)
    }
    switch (request.method, request.path) {
    case ("GET", "/api/tags"):
        return ModelHandler.tags()
    case ("POST", "/api/chat"):
        return await ModelHandler.chat(request.body)
    case ("GET", "/"), ("GET", "/health"):
        return .json(200, ["status": "ok", "model": bridgeModelName, "available": ModelHandler.availabilityError() == nil])
    default:
        return .error(404, "not found")
    }
}

func serve(_ connection: NWConnection, buffer: Data = Data()) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { chunk, _, isComplete, error in
        var data = buffer
        if let chunk { data.append(chunk) }

        switch HTTPParser.parse(data) {
        case .incomplete:
            if isComplete || error != nil {
                connection.cancel()
            } else {
                serve(connection, buffer: data)
            }
        case .invalid(let reason):
            send(.error(400, reason), on: connection)
        case .complete(let request):
            Task {
                let response = await route(request)
                send(response, on: connection)
            }
        }
    }
}

func send(_ response: HTTPResponse, on connection: NWConnection) {
    connection.send(content: response.serialized(), completion: .contentProcessed { _ in
        connection.cancel()
    })
}

guard let nwPort = NWEndpoint.Port(rawValue: port) else {
    FileHandle.standardError.write(Data("invalid APPLE_BRIDGE_PORT\n".utf8))
    exit(2)
}

let parameters = NWParameters.tcp
// Bind to loopback only — the bridge is never reachable from the network.
parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: nwPort)
parameters.allowLocalEndpointReuse = true

let listener: NWListener
do {
    listener = try NWListener(using: parameters)
} catch {
    FileHandle.standardError.write(Data("failed to listen on 127.0.0.1:\(port): \(error)\n".utf8))
    exit(1)
}

listener.newConnectionHandler = { connection in
    connection.start(queue: .global())
    serve(connection)
}
listener.stateUpdateHandler = { state in
    switch state {
    case .ready:
        let status = ModelHandler.availabilityError() ?? "model ready"
        print("ClearTrace Apple bridge listening on http://127.0.0.1:\(port) — \(status)")
        if token?.isEmpty ?? true {
            print("Tip: set APPLE_BRIDGE_TOKEN to require a bearer token from ClearTrace.")
        }
    case .failed(let error):
        FileHandle.standardError.write(Data("listener failed: \(error)\n".utf8))
        exit(1)
    default:
        break
    }
}
listener.start(queue: .main)
dispatchMain()
