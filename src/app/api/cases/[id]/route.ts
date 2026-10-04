import { ensureDatabase } from "@/lib/db/init";
import {
  getCaseTimeline,
  getIdentityClaimsRedacted,
  getLatestAuthorization,
} from "@/lib/cases/service";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { db } from "@/lib/db";
import { agentRuns } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { jsonOk } from "@/lib/api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id, {
    allowApiKey: true,
    scope: "cases:read",
  });
  if (access instanceof Response) return access;
  const { privacyCase } = access;

  const [authorization, claims, timeline, runs] = await Promise.all([
    getLatestAuthorization(id),
    getIdentityClaimsRedacted(id),
    getCaseTimeline(id),
    db.query.agentRuns.findMany({
      where: eq(agentRuns.caseId, id),
      orderBy: [desc(agentRuns.createdAt)],
    }),
  ]);

  return jsonOk({
    case: {
      ...privacyCase,
      scanScopes: JSON.parse(privacyCase.scanScopes) as string[],
    },
    authorization,
    identityClaims: claims,
    timeline,
    agentRuns: runs,
  });
}
