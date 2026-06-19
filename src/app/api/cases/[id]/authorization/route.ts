import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import {
  queueIntakeSkillRun,
  recordAuthorization,
} from "@/lib/cases/service";
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
  const {
    authorityBasis,
    userAttestation,
    guardianDocRef,
    poaRef,
    orgAuthRef,
  } = body as {
    authorityBasis?: string;
    userAttestation?: boolean;
    guardianDocRef?: string;
    poaRef?: string;
    orgAuthRef?: string;
  };

  if (!authorityBasis) {
    return jsonError("Authority basis is required");
  }

  try {
    const authId = await recordAuthorization(session, id, {
      authorityBasis,
      userAttestation: Boolean(userAttestation),
      guardianDocRef,
      poaRef,
      orgAuthRef,
    });

    if (userAttestation) {
      await queueIntakeSkillRun(session, id);
    }

    return jsonOk({ authorizationId: authId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (message === "ATTESTATION_REQUIRED") {
      return jsonError("Authorization attestation is required", 403);
    }
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : message;
    return jsonError(clientMsg, 500);
  }
}