import { logAuditEvent } from "@/lib/audit/logger";

export async function recordScopeUsage(params: {
  caseId: string;
  organizationId: string;
  userId?: string;
  action: string;
  claimTypes: string[];
  detail?: Record<string, unknown>;
}) {
  await logAuditEvent({
    caseId: params.caseId,
    organizationId: params.organizationId,
    userId: params.userId,
    eventType: "scope_ledger",
    summary: `${params.action}: used ${params.claimTypes.join(", ") || "no claims"}`,
    detail: {
      action: params.action,
      claimTypes: params.claimTypes,
      ...params.detail,
    },
  });
}