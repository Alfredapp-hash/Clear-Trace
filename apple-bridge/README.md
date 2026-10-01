# ClearTrace Apple bridge

Lets ClearTrace polish removal-request drafts with **Apple's on-device Foundation Model** (Apple Intelligence). Personal details never leave the Mac.

The bridge is a small Swift program. It serves the same two endpoints as Ollama, so ClearTrace talks to it like a local Ollama server:

| Route | Purpose |
|---|---|
| `GET /api/tags` | Lists `apple-on-device` when the model is available (503 with the reason when it isn't) |
| `POST /api/chat` | Ollama-shaped chat. A JSON-schema `format` returns `{subject, body}` through guided generation |
| `GET /health` | Liveness check plus model availability |

## Requirements

- An Apple Silicon Mac on macOS 26 or later, with **Apple Intelligence turned on** (System Settings → Apple Intelligence & Siri)
- Xcode 26 or later (Swift 6.2+)

## Build and run

```bash
cd apple-bridge
swift build -c release
.build/release/cleartrace-apple-bridge
```

It listens on `http://127.0.0.1:11435` by default.

| Env var | Default | Meaning |
|---|---|---|
| `APPLE_BRIDGE_PORT` | `11435` | Loopback port |
| `APPLE_BRIDGE_TOKEN` | unset | When set, requests must send `Authorization: Bearer <token>` (set the same token on the ClearTrace connector) |

To start it at login, copy `launchd/com.arkhe.cleartrace.apple-bridge.plist` to `~/Library/LaunchAgents/`. Set the binary path in the file, then run:

```bash
launchctl load ~/Library/LaunchAgents/com.arkhe.cleartrace.apple-bridge.plist
```

## Connect ClearTrace

Settings → Connectors → **Apple Intelligence (on-device)**. Keep the default URL `http://127.0.0.1:11435`, then click Save & test. It counts as **local** for Local-only AI.

## Safety

- It binds to `127.0.0.1` only, so it can't be reached from the network.
- It refuses any request that carries an `Origin` header (browsers), and any request whose `Host` isn't loopback. That stops web pages, including DNS-rebinding attacks, from using the model.
- Each request gets a fresh model session. Nothing is stored between drafts.
- Request bodies are capped at 256 KB, and chunked encoding is refused.

## Limits

- **4,096-token context.** That's plenty for one draft. Very long evidence excerpts return `413 context_window_exceeded`, and ClearTrace keeps the rules-based draft.
- **Apple's guardrails** may occasionally refuse text about people-search sites (`422 guardrail_violation`). ClearTrace then keeps the unpolished draft.
- **Docker:** a ClearTrace server running in Docker can't reach the bridge unless `host.docker.internal:11435` is added to the connector allow-list (`APPLE_BRIDGE_ALLOWED_ORIGINS`).

## Tests

```bash
swift test
```
