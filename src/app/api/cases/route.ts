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

  const session = toSessionLike(auth);
  const cases =
    auth.type === "api_key"
      ? await listCasesForOrganization(session.organizationId)
      : await listCasesForUser(session);
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

  const session = toSessionLike(auth);

  const body = await request.json();
  const { title, caseType, targetRelationship, scanScopes, ruthlessMode, familyMemberId } =
    body as {
      title?: string;
      caseType?: string;
      targetRelationship?: string;
      scanScopes?: string[];
      ruthlessMode?: boolean;
      familyMemberId?: string | null;
    };

  if (!title || !caseType || !targetRelationship) {
    return jsonError("Title, case type, and target relationship are required");
  }

  try {
    await assertCaseCreationAllowed(session.organizationId);
  } catch (error) {
    if (error instanceof Error && error.message === "BILLING_CASE_LIMIT") {
      return jsonError("Case limit reached. Upgrade to Pro on Billing.", 402);
    }
    throw error;
  }

  const caseId = await createPrivacyCase(session, {
    title,
    caseType,
    targetRelationship,
    scanScopes: scanScopes ?? [],
    ruthlessMode: !!ruthlessMode,
    familyMemberId: familyMemberId ?? null,
  });

  return jsonOk({ caseId }, 201);
}