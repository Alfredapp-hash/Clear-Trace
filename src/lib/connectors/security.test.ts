import { describe, expect, it } from "vitest";
import { buildGmailRawMessage } from "./connection/providers";
import { mergeStoredCredentials } from "./service";

function decode(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

describe("stored secrets are dropped when the destination changes", () => {
  it("keeps stored secrets when only non-destination fields change", () => {
    const { credentials, destinationChanged } = mergeStoredCredentials(
      "generic_webhook",
      { url: "https://hooks.example/a", authHeader: "Bearer secret" },
      { url: "https://hooks.example/a" },
    );
    expect(destinationChanged).toBe(false);
    expect(credentials.authHeader).toBe("Bearer secret");
  });

  it("drops the stored webhook auth header when the URL changes", () => {
    const { credentials, destinationChanged } = mergeStoredCredentials(
      "generic_webhook",
      { url: "https://hooks.example/a", authHeader: "Bearer secret" },
      { url: "https://attacker.example/steal" },
    );
    expect(destinationChanged).toBe(true);
    expect(credentials.authHeader).toBeUndefined();
    expect(credentials.url).toBe("https://attacker.example/steal");
  });

  it("requires the SMTP password again when host or port changes", () => {
    const stored = { host: "smtp.good.example", port: "587", user: "u", password: "pw" };
    expect(() => mergeStoredCredentials("smtp", stored, { host: "smtp.evil.example" })).toThrow(
      /Destination changed/,
    );
    expect(() => mergeStoredCredentials("smtp", stored, { port: "465" })).toThrow(
      /Destination changed/,
    );
    const ok = mergeStoredCredentials("smtp", stored, {
      host: "smtp.new.example",
      password: "new-pw",
    });
    expect(ok.credentials).toMatchObject({ host: "smtp.new.example", user: "u", password: "new-pw" });
  });

  it("never carries an Ollama Cloud key to a different base URL", () => {
    const { credentials } = mergeStoredCredentials(
      "ollama",
      { baseUrl: "https://ollama.com", apiKey: "cloud-key" },
      { baseUrl: "http://localhost:11434" },
    );
    expect(credentials.apiKey).toBeUndefined();
  });

  it("blank fields keep stored values when the destination is unchanged", () => {
    const { credentials } = mergeStoredCredentials(
      "ollama",
      { baseUrl: "https://ollama.com", apiKey: "cloud-key" },
      { baseUrl: "", apiKey: "  " },
    );
    expect(credentials.apiKey).toBe("cloud-key");
  });
});

describe("Gmail MIME construction", () => {
  const base = { to: "privacy@broker.example", subject: "Removal request", body: "Please remove." };

  it("rejects CRLF header injection in To / Subject / From", () => {
    expect(() =>
      buildGmailRawMessage({ ...base, to: "a@b.example\r\nBcc: victim@x.example" }),
    ).toThrow(/line break/);
    expect(() =>
      buildGmailRawMessage({ ...base, subject: "Hi\r\nBcc: victim@x.example" }),
    ).toThrow(/line break/);
    expect(() => buildGmailRawMessage({ ...base, subject: "Hi\nX-Evil: 1" })).toThrow();
    expect(() =>
      buildGmailRawMessage({ ...base, from: "me@x.example\r\nBcc: v@x.example" }),
    ).toThrow();
  });

  it("rejects a non-address recipient", () => {
    expect(() => buildGmailRawMessage({ ...base, to: "https://broker.example/optout" })).toThrow(
      /valid email/,
    );
  });

  it("adds From, RFC 2047-encodes non-ASCII subjects and base64 body", () => {
    const raw = decode(
      buildGmailRawMessage({ ...base, from: "me@x.example", subject: "Suppression — données" }),
    );
    expect(raw).toContain("From: me@x.example\r\n");
    expect(raw).toContain("To: privacy@broker.example\r\n");
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    const bodyPart = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(Buffer.from(bodyPart, "base64").toString("utf8")).toBe("Please remove.");
  });
});
