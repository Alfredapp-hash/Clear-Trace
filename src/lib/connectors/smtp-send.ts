import nodemailer from "nodemailer";
import { resolveSafeHost } from "@/lib/tools/safe-fetch";
import { ConnectorConnectionError } from "./connection/errors";
import { ALLOWED_SMTP_PORTS } from "./connection/providers";
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
  if (!ALLOWED_SMTP_PORTS.has(port)) {
    throw new ConnectorConnectionError("smtp", "invalid_config", "SMTP port must be 25, 465, 587 or 2525.");
  }
  if (!from) {
    throw new ConnectorConnectionError("smtp", "invalid_config", "From address is required in connector metadata.");
  }

  let address: string;
  try {
    address = await resolveSafeHost(host);
  } catch {
    throw new ConnectorConnectionError("smtp", "invalid_config", "SMTP host must be a public hostname.");
  }

  // Connect to the validated IP; keep the hostname for TLS SNI / certificate checks.
  const transporter = nodemailer.createTransport({
    host: address,
    port,
    secure: port === 465,
    auth: { user, pass: password },
    tls: { servername: host },
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