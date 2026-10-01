import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tools/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tools/safe-fetch")>();
  return { ...actual, safeRequest: vi.fn() };
});

import { safeRequest } from "@/lib/tools/safe-fetch";
import { connectorFetch } from "./http";
import {
  POLISH_FORMAT_SCHEMA,
  listOllamaModels,
  polishWithOllama,
  testOllamaConnection,
} from "./ollama";
import { classifyOllamaBaseUrl, getAllowedOllamaOrigins } from "./ollama-origin";
import { testConnectorConnection } from "./providers";

function jsonResponse(status: number, body: unknown) {
  return {
    url: "http://x/",
    status,
    headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
    body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    truncated: false,
  };
}

const mockedRequest = vi.mocked(safeRequest);

function lastCall() {
  const call = mockedRequest.mock.calls.at(-1)!;
  return { url: call[0], opts: call[1]! };
}

describe("Ollama origin allow-list", () => {
  it("uses the default local origins", () => {
    expect(getAllowedOllamaOrigins({})).toEqual([
      "http://localhost:11434",
      "http://127.0.0.1:11434",
      "http://host.docker.internal:11434",
    ]);
  });

  it("classifies local, cloud and rejected origins exactly", () => {
    expect(classifyOllamaBaseUrl("http://localhost:11434", {})).toEqual({
      mode: "local",
      origin: "http://localhost:11434",
    });
    expect(classifyOllamaBaseUrl("http://localhost:11434/", {})?.mode).toBe("local");
    expect(classifyOllamaBaseUrl("", {})?.mode).toBe("local"); // default base URL
    expect(classifyOllamaBaseUrl("https://ollama.com", {})).toEqual({
      mode: "cloud",
      origin: "https://ollama.com",
    });
    // Exact-origin match only
    expect(classifyOllamaBaseUrl("http://localhost:11435", {})).toBeNull();
    expect(classifyOllamaBaseUrl("https://localhost:11434", {})).toBeNull();
    expect(classifyOllamaBaseUrl("http://127.0.0.1:8080", {})).toBeNull();
    expect(classifyOllamaBaseUrl("http://169.254.169.254", {})).toBeNull();
    expect(classifyOllamaBaseUrl("http://ollama.com", {})).toBeNull();
    expect(classifyOllamaBaseUrl("https://evil.example", {})).toBeNull();
    expect(classifyOllamaBaseUrl("http://localhost:11434/api/admin", {})).toBeNull();
    expect(classifyOllamaBaseUrl("http://user:pw@localhost:11434", {})).toBeNull();
    expect(classifyOllamaBaseUrl("not a url", {})).toBeNull();
  });

  it("honours OLLAMA_ALLOWED_ORIGINS and never lets it claim the cloud origin", () => {
    const env = { OLLAMA_ALLOWED_ORIGINS: "http://10.0.0.5:11434, https://ollama.com" };
    expect(classifyOllamaBaseUrl("http://10.0.0.5:11434", env)?.mode).toBe("local");
    expect(classifyOllamaBaseUrl("http://localhost:11434", env)).toBeNull();
    expect(classifyOllamaBaseUrl("https://ollama.com", env)?.mode).toBe("cloud");
  });
});

describe("Ollama provider", () => {
  beforeEach(() => {
    mockedRequest.mockReset();
  });

  it("local: posts to /api/chat without auth, think:false, JSON-schema format, private network allowed", async () => {
    mockedRequest.mockResolvedValue(
      jsonResponse(200, {
        message: { role: "assistant", content: JSON.stringify({ subject: "S2", body: "B2" }) },
      }),
    );
    const result = await polishWithOllama(
      { baseUrl: "http://localhost:11434", apiKey: "should-not-be-sent" },
      "qwen3:8b",
      "S",
      "B",
      "factual",
    );
    expect(result).toEqual({ subject: "S2", body: "B2" });
    const { url, opts } = lastCall();
    expect(url).toBe("http://localhost:11434/api/chat");
    expect(opts.method).toBe("POST");
    expect(opts.allowPrivateNetwork).toBe(true);
    expect(opts.timeoutMs).toBe(120_000);
    expect(Object.keys(opts.headers ?? {}).map((k) => k.toLowerCase())).not.toContain(
      "authorization",
    );
    const body = JSON.parse(String(opts.body));
    expect(body).toMatchObject({
      model: "qwen3:8b",
      stream: false,
      think: false,
      format: POLISH_FORMAT_SCHEMA,
      options: { temperature: 0.2 },
    });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(mockedRequest).toHaveBeenCalledTimes(1); // retries: 0
  });

  it("cloud: sends Bearer key to https://ollama.com and does NOT bypass the blocklist", async () => {
    mockedRequest.mockResolvedValue(
      jsonResponse(200, { message: { content: '{"subject":"x","body":"y"}' } }),
    );
    await polishWithOllama(
      { baseUrl: "https://ollama.com", apiKey: "ok-key" },
      "gpt-oss:120b",
      "S",
      "B",
      "firm",
    );
    const { url, opts } = lastCall();
    expect(url).toBe("https://ollama.com/api/chat");
    expect(opts.headers?.Authorization).toBe("Bearer ok-key");
    expect(opts.allowPrivateNetwork).toBe(false);
  });

  it("returns null (unpolished) on bad JSON content", async () => {
    mockedRequest.mockResolvedValue(
      jsonResponse(200, { message: { content: "Sure! Here is your draft: subject..." } }),
    );
    expect(
      await polishWithOllama({ baseUrl: "http://localhost:11434" }, undefined, "S", "B", "factual"),
    ).toBeNull();
  });

  it("returns null when the JSON lacks a body", async () => {
    mockedRequest.mockResolvedValue(jsonResponse(200, { message: { content: '{"subject":"x"}' } }));
    expect(
      await polishWithOllama({ baseUrl: "http://localhost:11434" }, undefined, "S", "B", "factual"),
    ).toBeNull();
  });

  it("returns null when the server is unreachable or errors", async () => {
    mockedRequest.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    expect(
      await polishWithOllama({ baseUrl: "http://localhost:11434" }, undefined, "S", "B", "factual"),
    ).toBeNull();
    mockedRequest.mockResolvedValue(jsonResponse(500, { error: "boom" }));
    expect(
      await polishWithOllama({ baseUrl: "http://localhost:11434" }, undefined, "S", "B", "factual"),
    ).toBeNull();
  });

  it("refuses non-allow-listed origins and cloud without a key — no request made", async () => {
    expect(
      await polishWithOllama({ baseUrl: "http://192.168.1.50:11434" }, undefined, "S", "B", "factual"),
    ).toBeNull();
    expect(
      await polishWithOllama({ baseUrl: "https://ollama.com" }, undefined, "S", "B", "factual"),
    ).toBeNull();
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it("lists models from /api/tags and checks the configured model", async () => {
    mockedRequest.mockResolvedValue(
      jsonResponse(200, { models: [{ name: "qwen3:8b" }, { name: "llama3:latest" }] }),
    );
    const listed = await listOllamaModels({ baseUrl: "http://127.0.0.1:11434" });
    expect(listed.models).toEqual(["qwen3:8b", "llama3:latest"]);
    expect(lastCall().url).toBe("http://127.0.0.1:11434/api/tags");

    const ok = await testOllamaConnection({ baseUrl: "http://127.0.0.1:11434" }, { model: "llama3" });
    expect(ok.modelAvailable).toBe(true);
    const missing = await testOllamaConnection({ baseUrl: "http://127.0.0.1:11434" }, { model: "mistral" });
    expect(missing.modelAvailable).toBe(false);
  });

  it("tester reports missing model as a failure with the model list", async () => {
    mockedRequest.mockResolvedValue(jsonResponse(200, { models: [{ name: "llama3:latest" }] }));
    const result = await testConnectorConnection("ollama", { baseUrl: "http://localhost:11434" }, {});
    expect(result.ok).toBe(false);
    expect(result.detail?.models).toEqual(["llama3:latest"]);
    expect(result.detail?.mode).toBe("local");
  });

  it("tester rejects a non-allow-listed origin", async () => {
    const result = await testConnectorConnection("ollama", { baseUrl: "http://10.1.1.1:11434" }, {});
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_config");
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});

describe("connectorFetch private-network guard", () => {
  beforeEach(() => mockedRequest.mockReset());

  it("only honours allowPrivateNetwork for ollama on an allow-listed origin", async () => {
    await expect(
      connectorFetch({
        provider: "generic_webhook",
        url: "http://localhost:11434/",
        allowPrivateNetwork: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });
    await expect(
      connectorFetch({
        provider: "ollama",
        url: "http://169.254.169.254/latest",
        allowPrivateNetwork: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it("maps SSRF refusals to invalid_config and treats redirects as errors", async () => {
    mockedRequest.mockRejectedValueOnce(new Error("PRIVATE_IP_BLOCKED"));
    await expect(
      connectorFetch({ provider: "generic_webhook", url: "https://hooks.example/x", retries: 0 }),
    ).rejects.toMatchObject({ code: "invalid_config" });

    mockedRequest.mockResolvedValueOnce({
      url: "https://hooks.example/x",
      status: 302,
      headers: new Headers({ location: "http://169.254.169.254/" }),
      body: Buffer.alloc(0),
      truncated: false,
    });
    await expect(
      connectorFetch({ provider: "generic_webhook", url: "https://hooks.example/x", retries: 0 }),
    ).rejects.toMatchObject({ statusCode: 302 });
    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });
});
