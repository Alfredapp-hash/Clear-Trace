import { ensureDatabase } from "@/lib/db/init";
import { addIdentityClaims } from "@/lib/cases/service";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { jsonError, jsonOk } from "@/lib/api";
import { BIRTH_YEAR_PATTERN, defaultScanEnabled } from "@/lib/constants";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id);
  if (access instanceof Response) return access;

  const body = await request.json().catch(() => ({}));
  const { claims } = body as {
    claims?: Array<{
      claimType: string;
      value: string;
      scanEnabled?: boolean;
    }>;
  };

  if (!Array.isArray(claims) || !claims.length) {
    return jsonError("At least one identity claim is required");
  }
  if (!claims.every((c) => c && typeof c.claimType === "string" && typeof c.value === "string")) {
    return jsonError("Each claim needs a claimType and value");
  }
  // Disambiguators: a birth year is a year only, and a full date of birth is never stored.
  if (claims.some((c) => c.claimType === "date_of_birth")) {
    return jsonError(
      "A full date of birth is not accepted. Enter your birth year only (for example 1991).",
    );
  }
  if (claims.some((c) => c.claimType === "birth_year" && !BIRTH_YEAR_PATTERN.test(c.value.trim()))) {
    return jsonError("Birth year must be a four-digit year only (for example 1991), not a full date.");
  }

  try {
    const claimIds = await addIdentityClaims(
      access.session,
      id,
      claims.map((c) => ({
        claimType: c.claimType,
        value: c.claimType === "birth_year" ? c.value.trim() : c.value,
        // birth_year and relative_name are never searched, so they default to off.
        scanEnabled: typeof c.scanEnabled === "boolean" ? c.scanEnabled : defaultScanEnabled(c.claimType),
      })),
    );
    return jsonOk({ claimIds }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : message;
    return jsonError(clientMsg, 500);
  }
}
