import { and, desc, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { familyMembers } from "@/lib/db/schema";
import { getBillingStatus } from "@/lib/billing/service";
import { FAMILY_SEAT_LIMITS } from "@/lib/billing/plans";

export async function getFamilySeatLimit(organizationId: string): Promise<number> {
  const status = await getBillingStatus(organizationId);
  return FAMILY_SEAT_LIMITS[status.plan];
}

export async function listFamilyMembers(organizationId: string) {
  return db.query.familyMembers.findMany({
    where: eq(familyMembers.organizationId, organizationId),
    orderBy: [desc(familyMembers.createdAt)],
  });
}

export async function createFamilyMember(
  organizationId: string,
  input: { displayName: string; relationship: string; notes?: string },
) {
  const limit = await getFamilySeatLimit(organizationId);
  if (limit <= 0) {
    throw new Error("BILLING_FAMILY_SEATS");
  }

  const countRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(familyMembers)
    .where(eq(familyMembers.organizationId, organizationId));
  const count = countRows[0]?.count ?? 0;
  if (count >= limit) {
    throw new Error("FAMILY_SEAT_LIMIT");
  }

  const id = uuid();
  const now = new Date().toISOString();
  await db.insert(familyMembers).values({
    id,
    organizationId,
    displayName: input.displayName.trim(),
    relationship: input.relationship,
    notes: input.notes?.trim() || null,
    createdAt: now,
  });
  return id;
}

export async function deleteFamilyMember(organizationId: string, memberId: string) {
  const row = await db.query.familyMembers.findFirst({
    where: and(
      eq(familyMembers.id, memberId),
      eq(familyMembers.organizationId, organizationId),
    ),
  });
  if (!row) throw new Error("NOT_FOUND");
  await db.delete(familyMembers).where(eq(familyMembers.id, memberId));
}