import { desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { deindexRequests, verifiedExposures } from "@/lib/db/schema";
import { getCaseForUser } from "@/lib/cases/service";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireBillingFeature } from "@/lib/billing/service";
import type { SessionPayload } from "@/lib/auth/session";
import { buildDeindexDraft, DEINDEX_TOOLS, type SearchEngine } from "./playbook";

export async function createDeindexRequests(
  session: SessionPayload,
  caseId: string,
  engines: SearchEngine[] = ["google", "bing"],
): Promise<{ created: number; requests: string[] }> {
  await requireBillingFeature(session.organizationId, "deindex_workflow");

  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const exposures = await db.query.verifiedExposures.findMany({
    where: eq(verifiedExposures.caseId, caseId),
  });
  if (exposures.length === 0) throw new Error("NO_EXPOSURES");

  const targetEngines = engines.length ? engines : (["google"] as SearchEngine[]);
  const ids: string[] = [];
  const now = new Date().toISOString();

  for (const exp of exposures.slice(0, 5)) {
    for (const engine of targetEngines) {
      const draft = buildDeindexDraft(exp.canonicalUrl, engine);
      const id = uuid();
      await db.insert(deindexRequests).values({
        id,
        caseId,
        organizationId: session.organizationId,
        exposureId: exp.id,
        sourceUrl: exp.canonicalUrl,
        searchEngine: engine,
        toolUrl: draft.tool.toolUrl,
        draftSubject: draft.subject,
        draftBody: draft.body,
        status: "draft",
        createdAt: now,
      });
      ids.push(id);
    }
  }

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "deindex_requests_created",
    summary: `Created ${ids.length} search deindex request draft(s)`,
  });

  return { created: ids.length, requests: ids };
}

export async function listDeindexRequests(caseId: string, session: SessionPayload) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  return db.query.deindexRequests.findMany({
    where: eq(deindexRequests.caseId, caseId),
    orderBy: [desc(deindexRequests.createdAt)],
  });
}

export { DEINDEX_TOOLS };