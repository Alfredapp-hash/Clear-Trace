import { createHash } from "crypto";
import { requireBillingFeature } from "@/lib/billing/service";
import { ConnectorConnectionError } from "./connection/errors";
import { connectorFetch } from "./connection/http";
import { sendViaSmtp } from "./smtp-send";
import {
  getAgentDefaults,
  getOrgConnector,
  resolveEmailConnector,
} from "./service";
import type { ConnectorType } from "./types";

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  /**
   * Stable key for provider-side de-duplication (Resend `Idempotency-Key`). Callers that send a
   * stored draft should pass `removal-email/<draftId>`; when omitted it is derived from the
   * organization, recipient, subject and body so a retried send of the same message is deduped.
   */
  idempotencyKey?: string;
}

export interface SendEmailResult {
  provider: ConnectorType;
  messageId: string;
}

/** Resend caps idempotency keys at 256 characters and keeps them for 24 hours. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export function emailIdempotencyKey(organizationId: string, input: SendEmailInput): string {
  const explicit = input.idempotencyKey?.trim();
  if (explicit) {
    if (explicit.length <= MAX_IDEMPOTENCY_KEY_LENGTH) return explicit;
    return `key-sha256/${createHash("sha256").update(explicit).digest("hex")}`;
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([organizationId, input.to.trim().toLowerCase(), input.subject, input.body]))
    .digest("hex");
  return `email/${digest}`;
}

const SEND_CAPABLE: ConnectorType[] = ["smtp", "resend", "sendgrid", "postmark"];

export async function isOptionalEmailSendEnabled(organizationId: string): Promise<boolean> {
  const defaults = await getAgentDefaults(organizationId);
  if (!defaults.emailAutoSend) return false;
  return isDigestEmailSendEnabled(organizationId);
}

/** Digest and notifications — connector only; does not require emailAutoSend. */
export async function isDigestEmailSendEnabled(organizationId: string): Promise<boolean> {
  const type = await resolveEmailConnector(organizationId);
  return !!type && SEND_CAPABLE.includes(type);
}

async function sendViaEmailConnector(
  organizationId: string,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const type = await resolveEmailConnector(organizationId);
  if (!type || !SEND_CAPABLE.includes(type)) {
    throw new ConnectorConnectionError(
      "resend",
      "unsupported",
      "Configure SMTP, Resend, SendGrid, or Postmark and select it as the preferred email connector.",
    );
  }

  const connector = await getOrgConnector(organizationId, type);
  if (!connector) {
    throw new ConnectorConnectionError(type, "missing_credentials", "Email connector not connected.");
  }

  const from = connector.metadata.fromEmail?.trim();
  if (!from) {
    throw new ConnectorConnectionError(type, "invalid_config", "From address is required in connector metadata.");
  }

  if (type === "smtp") {
    return sendViaSmtp(connector.credentials, connector.metadata, input);
  }

  if (type === "resend") {
    const res = await connectorFetch<{ id?: string }>({
      provider: "resend",
      url: "https://api.resend.com/emails",
      method: "POST",
      headers: {
        Authorization: `Bearer ${connector.credentials.apiKey}`,
        "Content-Type": "application/json",
        // Resend returns the original response for a repeated key instead of sending again.
        "Idempotency-Key": emailIdempotencyKey(organizationId, input),
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.body,
      }),
      // Never auto-retry a send: a retried POST can deliver the email twice.
      retries: 0,
    });
    return { provider: type, messageId: res.data.id ?? "unknown" };
  }

  if (type === "sendgrid") {
    await connectorFetch({
      provider: "sendgrid",
      url: "https://api.sendgrid.com/v3/mail/send",
      method: "POST",
      headers: {
        Authorization: `Bearer ${connector.credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: input.to }] }],
        from: { email: from },
        subject: input.subject,
        content: [{ type: "text/plain", value: input.body }],
      }),
      retries: 0,
    });
    return { provider: type, messageId: `sendgrid-${Date.now()}` };
  }

  const res = await connectorFetch<{ MessageID?: string }>({
    provider: "postmark",
    url: "https://api.postmarkapp.com/email",
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": connector.credentials.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      From: from,
      To: input.to,
      Subject: input.subject,
      TextBody: input.body,
    }),
    retries: 0,
  });
  return { provider: type, messageId: res.data.MessageID ?? "unknown" };
}

export async function sendRemovalEmail(
  organizationId: string,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const defaults = await getAgentDefaults(organizationId);
  if (!defaults.emailAutoSend) {
    throw new ConnectorConnectionError(
      "resend",
      "unsupported",
      "Email auto-send is disabled. Enable it in Settings → Agent defaults.",
    );
  }

  await requireBillingFeature(organizationId, "email_auto_send");
  return sendViaEmailConnector(organizationId, input);
}

/** Weekly digest and system notifications — bypasses emailAutoSend. */
export async function sendNotificationEmail(
  organizationId: string,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  await requireBillingFeature(organizationId, "email_digest");
  return sendViaEmailConnector(organizationId, input);
}