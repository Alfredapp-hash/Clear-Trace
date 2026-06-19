import nodemailer from "nodemailer";
import { ConnectorConnectionError } from "./connection/errors";
import type { ConnectorCredentials } from "./types";
import type { SendEmailInput, SendEmailResult } from "./email-send";

export async function sendViaSmtp(
  credentials: ConnectorCredentials,
  metadata: Record<string, string>,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const host = credentials.host?.trim();
  const port = Number.parseInt(credentials.port ?? "", 10);
  const user = credentials.user?.trim();
  const password = credentials.password;
  const from = metadata.fromEmail?.trim();

  if (!host || !user || !password) {
    throw new ConnectorConnectionError("smtp", "missing_credentials", "SMTP credentials incomplete.");
  }
  if (!Number.isFinite(port) || port <= 0) {
    throw new ConnectorConnectionError("smtp", "invalid_config", "SMTP port must be a valid number.");
  }
  if (!from) {
    throw new ConnectorConnectionError("smtp", "invalid_config", "From address is required in connector metadata.");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass: password },
  });

  try {
    const info = await transporter.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      text: input.body,
    });
    return { provider: "smtp", messageId: info.messageId ?? `smtp-${Date.now()}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "SMTP send failed";
    throw new ConnectorConnectionError("smtp", "provider_error", message);
  } finally {
    transporter.close();
  }
}