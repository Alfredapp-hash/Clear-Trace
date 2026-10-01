import Foundation

/// Minimal HTTP/1.1 request model — enough for the two Ollama-shaped routes the bridge serves.
struct HTTPRequest {
    let method: String
    let path: String
    let headers: [String: String]  // lowercased names
    let body: Data
}

enum ParseResult {
    case incomplete
    case invalid(String)
    case complete(HTTPRequest)
}

enum HTTPParser {
    static let maxHeaderBytes = 16 * 1024
    static let maxBodyBytes = 256 * 1024

    static func parse(_ buffer: Data) -> ParseResult {
        let separator = Data("\r\n\r\n".utf8)
        guard let headerEnd = buffer.range(of: separator) else {
            return buffer.count > maxHeaderBytes ? .invalid("headers too large") : .incomplete
        }
        guard let head = String(data: buffer[buffer.startIndex..<headerEnd.lowerBound], encoding: .utf8) else {
            return .invalid("headers not utf-8")
        }
        let lines = head.components(separatedBy: "\r\n")
        let requestLine = lines[0].split(separator: " ")
        guard requestLine.count == 3 else { return .invalid("bad request line") }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { return .invalid("bad header") }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        if headers["transfer-encoding"] != nil { return .invalid("chunked bodies not supported") }

        let length = Int(headers["content-length"] ?? "0") ?? -1
        guard length >= 0 else { return .invalid("bad content-length") }
        guard length <= maxBodyBytes else { return .invalid("body too large") }

        let bodyStart = headerEnd.upperBound
        let available = buffer.count - (bodyStart - buffer.startIndex)
        if available < length { return .incomplete }
        let body = buffer[bodyStart..<(bodyStart + length)]

        let rawPath = String(requestLine[1])
        let path = rawPath.split(separator: "?", maxSplits: 1).first.map(String.init) ?? rawPath
        return .complete(HTTPRequest(method: String(requestLine[0]), path: path, headers: headers, body: Data(body)))
    }
}

/// Requests must come from local processes (the ClearTrace server), never from a web page.
enum RequestGuard {
    /// Returns (status, message) when the request must be refused.
    static func refusal(for request: HTTPRequest, port: UInt16, token: String?) -> (Int, String)? {
        // Browsers always send Origin on cross-origin POSTs; a local server process does not.
        if request.headers["origin"] != nil {
            return (403, "browser requests are not allowed")
        }
        // DNS-rebinding defence: only accept loopback Host headers.
        let allowedHosts: Set<String> = ["127.0.0.1:\(port)", "localhost:\(port)", "[::1]:\(port)"]
        guard let host = request.headers["host"]?.lowercased(), allowedHosts.contains(host) else {
            return (403, "host not allowed")
        }
        if let token, !token.isEmpty {
            guard request.headers["authorization"] == "Bearer \(token)" else {
                return (401, "missing or invalid bridge token")
            }
        }
        return nil
    }
}

struct HTTPResponse {
    let status: Int
    let body: Data

    static func json(_ status: Int, _ object: Any) -> HTTPResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return HTTPResponse(status: status, body: data)
    }

    static func error(_ status: Int, _ message: String) -> HTTPResponse {
        json(status, ["error": message])
    }

    func serialized() -> Data {
        let reason: String
        switch status {
        case 200: reason = "OK"
        case 400: reason = "Bad Request"
        case 401: reason = "Unauthorized"
        case 403: reason = "Forbidden"
        case 404: reason = "Not Found"
        case 413: reason = "Payload Too Large"
        case 422: reason = "Unprocessable Content"
        case 503: reason = "Service Unavailable"
        default: reason = "Internal Server Error"
        }
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        head += "Content-Type: application/json\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Connection: close\r\n\r\n"
        return Data(head.utf8) + body
    }
}
