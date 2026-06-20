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
}

export interface SendEmailResult {
  provider: ConnectorType;
  messageId: string;
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
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.body,
      }),
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