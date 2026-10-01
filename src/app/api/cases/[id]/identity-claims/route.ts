import { ensureDatabase } from "@/lib/db/init";
import { addIdentityClaims } from "@/lib/cases/service";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { jsonError, jsonOk } from "@/lib/api";

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

  try {
    const claimIds = await addIdentityClaims(
      access.session,
      id,
      claims.map((c) => ({
        claimType: c.claimType,
        value: c.value,
        scanEnabled: c.scanEnabled ?? true,
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
