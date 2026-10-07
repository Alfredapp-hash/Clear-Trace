import { ensureDatabase } from "@/lib/db/init";
import {
  getCaseTimeline,
  getIdentityClaimsRedacted,
  getLatestAuthorization,
} from "@/lib/cases/service";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { db } from "@/lib/db";
import { agentRuns } from "@/lib/db/schema";
import { and, eq, desc } from "drizzle-orm";
import { jsonOk } from "@/lib/api";
import { clampPageLimit, decodePageCursor, olderThan, toPage } from "@/lib/cases/page-cursor";

/** One page of the case's agent runs, newest first (same keyset cursor as the timeline). */
async function getAgentRunsPage(caseId: string, limitParam: string | null, cursorParam: string | null) {
  const limit = clampPageLimit(limitParam);
  const cursor = decodePageCursor(cursorParam);
  const rows = await db.query.agentRuns.findMany({
    where: cursor
      ? and(eq(agentRuns.caseId, caseId), olderThan(agentRuns.createdAt, agentRuns.id, cursor))
      : eq(agentRuns.caseId, caseId),
    orderBy: [desc(agentRuns.createdAt), desc(agentRuns.id)],
    limit: limit + 1,
  });
  return toPage(rows, limit);
}

/**
 * GET /api/cases/[id]: the case, its consent record, redacted claims, and the newest page of
 * the audit timeline and agent runs. Both lists are bounded (default 50, max 200):
 * `timelineLimit` / `timelineCursor` and `runsLimit` / `runsCursor` page through older rows
 * using the `timelineNextCursor` / `agentRunsNextCursor` returned here (null = no more).
 * `section=timeline` returns only the timeline page (the case page's "Show older events").
 */
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

  const query = new URL(request.url).searchParams;
  const timelineOpts = {
    limit: clampPageLimit(query.get("timelineLimit")),
    cursor: query.get("timelineCursor"),
  };

  if (query.get("section") === "timeline") {
    const timeline = await getCaseTimeline(id, timelineOpts);
    return jsonOk({ timeline: timeline.events, timelineNextCursor: timeline.nextCursor });
  }

  const [authorization, claims, timeline, runs] = await Promise.all([
    getLatestAuthorization(id),
    getIdentityClaimsRedacted(id),
    getCaseTimeline(id, timelineOpts),
    getAgentRunsPage(id, query.get("runsLimit"), query.get("runsCursor")),
  ]);

  return jsonOk({
    case: {
      ...privacyCase,
      scanScopes: JSON.parse(privacyCase.scanScopes) as string[],
    },
    authorization,
    identityClaims: claims,
    timeline: timeline.events,
    timelineNextCursor: timeline.nextCursor,
    agentRuns: runs.items,
    agentRunsNextCursor: runs.nextCursor,
  });
}
