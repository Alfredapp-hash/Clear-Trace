import { resolveAuth, requireScope, toSessionLike } from "@/lib/auth/resolve-auth";
import { assertCaseCreationAllowed } from "@/lib/billing/service";
import { ensureDatabase } from "@/lib/db/init";
import {
  createPrivacyCase,
  listCasesForOrganization,
  listCasesForUser,
} from "@/lib/cases/service";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET(request: Request) {
  ensureDatabase();
  const auth = await resolveAuth(request);
  if (!auth) return jsonError("Not authenticated", 401);

  try {
    requireScope(auth, "cases:read");
  } catch {
    return jsonError("API key missing cases:read scope", 403);
  }

  const cases =
    auth.type === "api_key"
      ? await listCasesForOrganization(auth.apiKey.organizationId)
      : await listCasesForUser(auth.session);
  return jsonOk({
    cases: cases.map((c) => ({
      ...c,
      scanScopes: JSON.parse(c.scanScopes) as string[],
    })),
  });
}

export async function POST(request: Request) {
  ensureDatabase();
  const auth = await resolveAuth(request);
  if (!auth) return jsonError("Not authenticated", 401);

  try {
    requireScope(auth, "cases:write");
  } catch {
    return jsonError("API key missing cases:write scope", 403);
  }

  if (auth.type === "api_key" && !auth.apiKey.actingUserId) {
    return jsonError("API key has no owning user; recreate the key", 403);
  }
  // For API keys the case owner is the key's creator (a real user row).
  const session = toSessionLike(auth);

  const body = await request.json().catch(() => ({}));
  const { title, caseType, targetRelationship, scanScopes, ruthlessMode, familyMemberId } =
    body as {
      title?: unknown;
      caseType?: unknown;
      targetRelationship?: unknown;
      scanScopes?: unknown;
      ruthlessMode?: boolean;
      familyMemberId?: unknown;
    };

  if (
    typeof title !== "string" ||
    typeof caseType !== "string" ||
    typeof targetRelationship !== "string" ||
    !title.trim() ||
    !caseType ||
    !targetRelationship
  ) {
    return jsonError("Title, case type, and target relationship are required");
  }
  if (scanScopes != null && (!Array.isArray(scanScopes) || !scanScopes.every((s) => typeof s === "string"))) {
    return jsonError("scanScopes must be an array of strings");
  }
  if (familyMemberId != null && typeof familyMemberId !== "string") {
    return jsonError("familyMemberId must be a string");
  }

  try {
    await assertCaseCreationAllowed(session.organizationId);
  } catch (error) {
    if (error instanceof Error && error.message === "BILLING_CASE_LIMIT") {
      return jsonError("Case limit reached. Upgrade to Pro on Billing.", 402);
    }
    throw error;
  }

  try {
    const caseId = await createPrivacyCase(session, {
      title,
      caseType,
      targetRelationship,
      scanScopes: (scanScopes as string[] | undefined) ?? [],
      ruthlessMode: !!ruthlessMode,
      familyMemberId: familyMemberId || null,
    });
    return jsonOk({ caseId }, 201);
  } catch (error) {
    if (error instanceof Error && error.message === "FAMILY_MEMBER_NOT_FOUND") {
      return jsonError("Family member not found", 400);
    }
    throw error;
  }
}
