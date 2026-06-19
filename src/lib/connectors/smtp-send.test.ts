import { describe, expect, it, vi, beforeEach } from "vitest";
import { sendViaSmtp } from "./smtp-send";

const sendMail = vi.fn();
const close = vi.fn();

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