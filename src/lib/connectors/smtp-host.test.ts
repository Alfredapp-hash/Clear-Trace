import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressResolver } from "@/lib/tools/safe-fetch";
import { isAllowedLanAddress, resolveSmtpHost, smtpAllowedHosts } from "./smtp-host";
import { testSmtp } from "./connection/providers";

const resolverFor =
  (...addresses: string[]): AddressResolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

const env = (hosts: string) => ({ SMTP_ALLOWED_HOSTS: hosts }) as unknown as NodeJS.ProcessEnv;

describe("smtpAllowedHosts", () => {
  it("parses a comma-separated, case-insensitive list of exact hosts", () => {
    expect([...smtpAllowedHosts(env(" Relay.LAN. , 192.168.1.10,,[fd00::25] "))]).toEqual([
      "relay.lan",
      "192.168.1.10",
      "fd00::25",
    ]);
    expect(smtpAllowedHosts({} as unknown as NodeJS.ProcessEnv).size).toBe(0);
  });
});

describe("isAllowedLanAddress", () => {
  it.each(["10.0.0.5", "172.20.1.1", "192.168.1.10", "100.101.102.103", "fd12::1", "::ffff:192.168.1.10", "93.184.215.14"])(
    "allows %s",
    (ip) => expect(isAllowedLanAddress(ip)).toBe(true),
  );
  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.100.100.200",
    "::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "224.0.0.1",
    "not-an-ip",
  ])("never allows %s", (ip) => expect(isAllowedLanAddress(ip)).toBe(false));
});

describe("resolveSmtpHost", () => {
  it("rejects private addresses for hosts not on the allow-list", async () => {
    await expect(resolveSmtpHost("192.168.1.10", { env: env("") })).rejects.toThrow();
    await expect(
      resolveSmtpHost("relay.lan", { env: env("other.lan"), resolver: resolverFor("192.168.1.10") }),
    ).rejects.toThrow();
  });

  it("still resolves public hosts without an allow-list entry", async () => {
    await expect(
      resolveSmtpHost("smtp.example.com", { env: env(""), resolver: resolverFor("93.184.215.14") }),
    ).resolves.toBe("93.184.215.14");
  });

  it("lets allow-listed hosts and IP literals resolve to private LAN addresses", async () => {
    await expect(
      resolveSmtpHost("Relay.LAN", { env: env("relay.lan"), resolver: resolverFor("192.168.1.10") }),
    ).resolves.toBe("192.168.1.10");
    await expect(resolveSmtpHost("10.0.0.25", { env: env("10.0.0.25") })).resolves.toBe("10.0.0.25");
  });

  it("never allows loopback or metadata, even when allow-listed", async () => {
    await expect(resolveSmtpHost("169.254.169.254", { env: env("169.254.169.254") })).rejects.toThrow();
    await expect(resolveSmtpHost("127.0.0.1", { env: env("127.0.0.1") })).rejects.toThrow();
    await expect(resolveSmtpHost("localhost", { env: env("localhost") })).rejects.toThrow();
    await expect(
      resolveSmtpHost("metadata.google.internal", { env: env("metadata.google.internal") }),
    ).rejects.toThrow();
    // An allow-listed name whose DNS answer includes a forbidden address is refused outright.
    await expect(
      resolveSmtpHost("relay.lan", {
        env: env("relay.lan"),
        resolver: resolverFor("192.168.1.10", "169.254.169.254"),
      }),
    ).rejects.toThrow("PRIVATE_IP_BLOCKED");
  });
});

describe("testSmtp honours SMTP_ALLOWED_HOSTS", () => {
  afterEach(() => vi.unstubAllEnvs());

  const creds = (host: string) => ({ host, port: "587", user: "u", password: "p" });

  it("rejects a private host that is not allow-listed", async () => {
    vi.stubEnv("SMTP_ALLOWED_HOSTS", "");
    const result = await testSmtp(creds("192.168.1.10"));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_config");
  });

  it("rejects cloud metadata even when allow-listed", async () => {
    vi.stubEnv("SMTP_ALLOWED_HOSTS", "169.254.169.254");
    const result = await testSmtp(creds("169.254.169.254"));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_config");
  });
});
