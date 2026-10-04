import Foundation
import FoundationModels

let bridgeModelName = "apple-on-device"

@Generable
struct PolishedDraft {
    @Guide(description: "Email subject line, plain text, one line. Keep the website name from the original subject.")
    let subject: String
    @Guide(description: "Email body, plain text. Keep the original paragraphs and line breaks (use \\n), every URL and email address exactly, and any [Evidence on file: ...] note unchanged. Do not add a greeting name, sign-off, signature or any personal name.")
    let body: String
}

/// Ollama-shaped chat request: `{ model, messages: [{ role, content }], format?, stream? }`.
struct ChatRequest {
    let instructions: String
    let prompt: String
    let wantsStructuredDraft: Bool

    static func decode(_ data: Data) -> ChatRequest? {
        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let messages = json["messages"] as? [[String: Any]]
        else { return nil }

        var system: [String] = []
        var user: [String] = []
        for message in messages {
            guard let role = message["role"] as? String, let content = message["content"] as? String else {
                continue
            }
            if role == "system" { system.append(content) } else if role == "user" { user.append(content) }
        }
        guard !user.isEmpty else { return nil }
        // ClearTrace sends a JSON-schema `format` for subject/body; any `format` means structured output.
        let wantsStructured = json["format"] != nil
        return ChatRequest(
            instructions: system.joined(separator: "\n\n"),
            prompt: user.joined(separator: "\n\n"),
            wantsStructuredDraft: wantsStructured
        )
    }
}

enum ModelHandler {
    static func availabilityError() -> String? {
        switch SystemLanguageModel.default.availability {
        case .available:
            return nil
        case .unavailable(let reason):
            return "Apple Intelligence model unavailable: \(reason)"
        }
    }

    static func tags() -> HTTPResponse {
        if let problem = availabilityError() {
            return .error(503, problem)
        }
        return .json(200, ["models": [["name": bridgeModelName, "model": bridgeModelName]]])
    }

    static func chat(_ body: Data) async -> HTTPResponse {
        if let problem = availabilityError() {
            return .error(503, problem)
        }
        guard let request = ChatRequest.decode(body) else {
            return .error(400, "expected { messages: [{ role, content }] } with at least one user message")
        }

        // A fresh session per request: no conversation state is kept between drafts.
        let session = LanguageModelSession(instructions: request.instructions)
        let options = GenerationOptions(temperature: 0.2)
        do {
            let content: String
            if request.wantsStructuredDraft {
                let draft = try await session.respond(to: request.prompt, generating: PolishedDraft.self, options: options).content
                let data = try JSONSerialization.data(withJSONObject: ["subject": draft.subject, "body": draft.body])
                content = String(decoding: data, as: UTF8.self)
            } else {
                content = try await session.respond(to: request.prompt, options: options).content
            }
            return .json(200, [
                "model": bridgeModelName,
                "message": ["role": "assistant", "content": content],
                "done": true,
            ])
        } catch let error as LanguageModelSession.GenerationError {
            switch error {
            case .guardrailViolation:
                return .error(422, "guardrail_violation")
            case .exceededContextWindowSize:
                return .error(413, "context_window_exceeded")
            default:
                return .error(500, "generation_failed")
            }
        } catch {
            return .error(500, "generation_failed")
        }
    }
}
