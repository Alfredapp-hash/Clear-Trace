import Foundation
import Testing
@testable import cleartrace_apple_bridge

private func request(_ raw: String) -> HTTPRequest? {
    if case .complete(let r) = HTTPParser.parse(Data(raw.utf8)) { return r }
    return nil
}

@Test func parsesCompleteRequestWithBody() {
    let r = request("POST /api/chat HTTP/1.1\r\nHost: 127.0.0.1:11435\r\nContent-Length: 2\r\n\r\n{}")
    #expect(r?.method == "POST")
    #expect(r?.path == "/api/chat")
    #expect(r?.body == Data("{}".utf8))
}

@Test func waitsForTheRestOfTheBody() {
    guard case .incomplete = HTTPParser.parse(Data("POST /api/chat HTTP/1.1\r\nContent-Length: 10\r\n\r\n{}".utf8)) else {
        Issue.record("expected incomplete"); return
    }
}

@Test func rejectsOversizedBodiesAndChunkedEncoding() {
    guard case .invalid = HTTPParser.parse(Data("POST / HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n".utf8)) else {
        Issue.record("expected invalid for huge body"); return
    }
    guard case .invalid = HTTPParser.parse(Data("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".utf8)) else {
        Issue.record("expected invalid for chunked"); return
    }
}

@Test func guardRefusesBrowserOriginsAndForeignHosts() {
    let browser = request("POST /api/chat HTTP/1.1\r\nHost: 127.0.0.1:11435\r\nOrigin: https://evil.test\r\n\r\n")!
    #expect(RequestGuard.refusal(for: browser, port: 11435, token: nil)?.0 == 403)

    let rebinding = request("GET /api/tags HTTP/1.1\r\nHost: evil.test:11435\r\n\r\n")!
    #expect(RequestGuard.refusal(for: rebinding, port: 11435, token: nil)?.0 == 403)

    let local = request("GET /api/tags HTTP/1.1\r\nHost: localhost:11435\r\n\r\n")!
    #expect(RequestGuard.refusal(for: local, port: 11435, token: nil) == nil)
}

@Test func guardEnforcesTokenWhenConfigured() {
    let noAuth = request("GET /api/tags HTTP/1.1\r\nHost: 127.0.0.1:11435\r\n\r\n")!
    #expect(RequestGuard.refusal(for: noAuth, port: 11435, token: "s3cret")?.0 == 401)

    let authed = request("GET /api/tags HTTP/1.1\r\nHost: 127.0.0.1:11435\r\nAuthorization: Bearer s3cret\r\n\r\n")!
    #expect(RequestGuard.refusal(for: authed, port: 11435, token: "s3cret") == nil)
}

@Test func decodesOllamaShapedChatRequest() {
    let json = #"{"model":"apple-on-device","messages":[{"role":"system","content":"Be factual."},{"role":"user","content":"Polish this."}],"format":{"type":"object"},"stream":false}"#
    let chat = ChatRequest.decode(Data(json.utf8))
    #expect(chat?.instructions == "Be factual.")
    #expect(chat?.prompt == "Polish this.")
    #expect(chat?.wantsStructuredDraft == true)
    #expect(ChatRequest.decode(Data(#"{"messages":[]}"#.utf8)) == nil)
}
