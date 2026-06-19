import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import {
  getCaseForUser,
  getCaseTimeline,
  getIdentityClaimsRedacted,
  getLatestAuthorization,
} from "@/lib/cases/service";
import { db } from "@/lib/db";
import { agentRuns } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const { id } = await params;
  const privacyCase = await getCaseForUser(id, session);
  if (!privacyCase) return jsonError("Case not found", 404);

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