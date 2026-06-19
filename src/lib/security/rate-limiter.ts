import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { rateLimitEvents } from "@/lib/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

export async function checkRateLimit(
  key: string,
  limitPerHour: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const recent = await db
    .select({ count: sql<number>`count(*)` })
    .from(rateLimitEvents)
    .where(
      and(
        eq(rateLimitEvents.key, key),
        gte(rateLimitEvents.createdAt, oneHourAgo),
      ),
    );

  const count = recent[0]?.count ?? 0;
  if (count >= limitPerHour) {
    return { allowed: false, remaining: 0 };
  }

  await db.insert(rateLimitEvents).values({
    id: uuid(),
    key,
    createdAt: new Date().toISOString(),
  });

  return { allowed: true, remaining: limitPerHour - count - 1 };
}