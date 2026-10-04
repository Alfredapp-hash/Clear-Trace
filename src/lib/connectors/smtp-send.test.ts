import { describe, expect, it, vi, beforeEach } from "vitest";
import nodemailer from "nodemailer";
import { sendViaSmtp } from "./smtp-send";
import { resolveSafeHost } from "@/lib/tools/safe-fetch";

const sendMail = vi.fn();
const close = vi.fn();

vi.mock("@/lib/tools/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/safe-fetch")>()),
  resolveSafeHost: vi.fn(async (host: string) => {
    if (host === "internal.example.com") throw new Error("PRIVATE_IP_BLOCKED");
    return "93.184.215.14";
  }),
  assertSafeUrl: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail,
      close,
    })),
  },
}));

describe("sendViaSmtp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMail.mockResolvedValue({ messageId: "<smtp-test@local>" });
  });

  it("sends mail with configured transport", async () => {
    const result = await sendViaSmtp(
      { host: "smtp.example.com", port: "587", user: "user", password: "secret" },
      { fromEmail: "from@example.com" },
      { to: "to@example.com", subject: "Removal request", body: "Please remove my listing." },
    );

    expect(result).toEqual({ provider: "smtp", messageId: "<smtp-test@local>" });
    expect(sendMail).toHaveBeenCalledWith({
      from: "from@example.com",
      to: "to@example.com",
      subject: "Removal request",
      text: "Please remove my listing.",
    });
    expect(close).toHaveBeenCalled();
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "93.184.215.14", tls: { servername: "smtp.example.com" } }),
    );
  });

  it("refuses private hosts and non-SMTP ports", async () => {
    await expect(
      sendViaSmtp(
        { host: "internal.example.com", port: "587", user: "u", password: "p" },
        { fromEmail: "from@example.com" },
        { to: "to@example.com", subject: "Hi", body: "Body" },
      ),
    ).rejects.toMatchObject({ code: "invalid_config" });
    await expect(
      sendViaSmtp(
        { host: "smtp.example.com", port: "6379", user: "u", password: "p" },
        { fromEmail: "from@example.com" },
        { to: "to@example.com", subject: "Hi", body: "Body" },
      ),
    ).rejects.toMatchObject({ code: "invalid_config" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("connects to a private-LAN relay only when it is in SMTP_ALLOWED_HOSTS", async () => {
    const creds = { host: "192.168.1.25", port: "587", user: "u", password: "p" };
    const msg = { to: "to@example.com", subject: "Hi", body: "Body" };
    vi.stubEnv("SMTP_ALLOWED_HOSTS", "");
    // not allow-listed: falls through to the public-only resolver
    vi.mocked(resolveSafeHost).mockRejectedValueOnce(new Error("PRIVATE_IP_BLOCKED"));
    await expect(sendViaSmtp(creds, { fromEmail: "from@example.com" }, msg)).rejects.toMatchObject({
      code: "invalid_config",
    });

    vi.stubEnv("SMTP_ALLOWED_HOSTS", "192.168.1.25");
    await sendViaSmtp(creds, { fromEmail: "from@example.com" }, msg);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "192.168.1.25" }),
    );

    vi.stubEnv("SMTP_ALLOWED_HOSTS", "169.254.169.254");
    await expect(
      sendViaSmtp({ ...creds, host: "169.254.169.254" }, { fromEmail: "from@example.com" }, msg),
    ).rejects.toMatchObject({ code: "invalid_config" });
    vi.unstubAllEnvs();
  });

  it("rejects incomplete credentials", async () => {
    await expect(
      sendViaSmtp(
        { host: "smtp.example.com", port: "587" },
        { fromEmail: "from@example.com" },
        { to: "to@example.com", subject: "Hi", body: "Body" },
      ),
    ).rejects.toMatchObject({ code: "missing_credentials" });
  });
});