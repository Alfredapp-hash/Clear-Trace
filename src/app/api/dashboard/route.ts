import { eq, desc } from "drizzle-orm";
import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { privacyCases, auditEvents } from "@/lib/db/schema";
import { loadSkillRegistry } from "@/lib/skills/registry";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET() {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const cases = await db.query.privacyCases.findMany({
    where: eq(privacyCases.ownerUserId, session.userId),
    orderBy: [desc(privacyCases.updatedAt)],
    limit: 5,
  });

  const recentEvents = await db.query.auditEvents.findMany({
    where: eq(auditEvents.organizationId, session.organizationId),
    orderBy: [desc(auditEvents.createdAt)],
    limit: 10,
  });

  const skills = loadSkillRegistry();

  const statusCounts = cases.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});

  return jsonOk({
    summary: {
      totalCases: cases.length,
      verifiedCases: cases.filter((c) => c.status === "consent_verified").length,
      draftCases: cases.filter((c) => c.status === "draft").length,
      registeredSkills: skills.length,
      statusCounts,
    },
    recentCases: cases.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      updatedAt: c.updatedAt,
    })),
    recentEvents,
  });
}