import { getConnectionHelper } from "@/lib/connectors/service";

interface GmailMessage {
  subject: string;
  body: string;
  to: string;
  from?: string;
}

export async function createGmailDraft(
  organizationId: string,
  message: GmailMessage,
): Promise<{ draftId: string; message: string }> {
  const helper = getConnectionHelper(organizationId);
  return helper.pushGmailDraft(message);
}