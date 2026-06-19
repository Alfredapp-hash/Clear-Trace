import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { addIdentityClaims } from "@/lib/cases/service";
import { jsonError, jsonOk } from "@/lib/api";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const { id } = await params;
  const body = await request.json();
  const { claims } = body as {
    claims?: Array<{
      claimType: string;
      value: string;
      scanEnabled?: boolean;
    }>;
  };

  if (!claims?.length) {
    return jsonError("At least one identity claim is required");
  }

  try {
    const claimIds = await addIdentityClaims(
      session,
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