import { getSession } from "@/lib/auth/session";
import { requireOrgAdminSession } from "@/lib/auth/org-role";
import { ensureDatabase } from "@/lib/db/init";
import { jsonError, jsonOk } from "@/lib/api";
import {
  createFamilyMember,
  deleteFamilyMember,
  getFamilySeatLimit,
  listFamilyMembers,
} from "@/lib/family/service";

export async function GET() {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Unauthorized", 401);

  const [members, seatLimit] = await Promise.all([
    listFamilyMembers(session.organizationId),
    getFamilySeatLimit(session.organizationId),
  ]);

  return jsonOk({ members, seatLimit, used: members.length });
}

export async function POST(request: Request) {
  ensureDatabase();
  const guard = await requireOrgAdminSession();
  if (guard.error) return guard.error;
  const { session } = guard;

  const body = await request.json().catch(() => ({}));
  const { displayName, relationship, notes } = body as {
    displayName?: unknown;
    relationship?: unknown;
    notes?: unknown;
  };

  if (
    typeof displayName !== "string" ||
    typeof relationship !== "string" ||
    !displayName.trim() ||
    !relationship
  ) {
    return jsonError("displayName and relationship required");
  }
  if (notes != null && typeof notes !== "string") return jsonError("notes must be a string");

  try {
    const id = await createFamilyMember(session.organizationId, {
      displayName,
      relationship,
      notes: notes ?? undefined,
    });
    return jsonOk({ id }, 201);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "BILLING_FAMILY_SEATS") {
        return jsonError("Family seats require Pro plan", 402);
      }
      if (error.message === "FAMILY_SEAT_LIMIT") {
        return jsonError("Family seat limit reached", 400);
      }
    }
    throw error;
  }
}

export async function DELETE(request: Request) {
  ensureDatabase();
  const guard = await requireOrgAdminSession();
  if (guard.error) return guard.error;
  const { session } = guard;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return jsonError("id required");

  try {
    await deleteFamilyMember(session.organizationId, id);
    return jsonOk({ deleted: true });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") {
      return jsonError("Member not found", 404);
    }
    throw error;
  }
}