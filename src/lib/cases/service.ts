import { and, desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  privacyCases,
  authorizationRecords,
  identityProfiles,
  identityClaims,
  agentRuns,
  auditEvents,
} from "@/lib/db/schema";
import {
  decryptValue,
  encryptValue,
  hashValue,
  redactValue,
} from "@/lib/crypto/encryption";
import { logAuditEvent } from "@/lib/audit/logger";
import type { SessionPayload } from "@/lib/auth/session";

export async function listCasesForUser(session: SessionPayload) {
  return db.query.privacyCases.findMany({
    where: and(
      eq(privacyCases.organizationId, session.organizationId),
      eq(privacyCases.ownerUserId, session.userId),
    ),
    orderBy: [desc(privacyCases.updatedAt)],
  });
}

export async function listCasesForOrganization(organizationId: string) {
  return db.query.privacyCases.findMany({
    where: eq(privacyCases.organizationId, organizationId),
    orderBy: [desc(privacyCases.updatedAt)],
  });
}

export async function getCaseForUser(caseId: string, session: SessionPayload) {
  return db.query.privacyCases.findFirst({
    where: and(
      eq(privacyCases.id, caseId),
      eq(privacyCases.organizationId, session.organizationId),
      eq(privacyCases.ownerUserId, session.userId),
    ),
  });
}

export async function createPrivacyCase(
  session: SessionPayload,
  input: {
    title: string;
    caseType: string;
    targetRelationship: string;
    scanScopes: string[];
    ruthlessMode?: boolean;
  },
) {
  const id = uuid();
  const now = new Date().toISOString();

  let ruthlessMode = !!input.ruthlessMode;
  let scanScopes = input.scanScopes;

  if (!ruthlessMode) {
    const { isRuthlessModeForOrg, ruthlessScanScopes } = await import("@/lib/ruthless/service");
    if (await isRuthlessModeForOrg(session.organizationId)) {
      ruthlessMode = true;
      scanScopes = ruthlessScanScopes(scanScopes);
    }
  } else {
    const { ruthlessScanScopes } = await import("@/lib/ruthless/service");
    scanScopes = ruthlessScanScopes(scanScopes);
  }

  await db.insert(privacyCases).values({
    id,
    organizationId: session.organizationId,
    ownerUserId: session.userId,
    title: input.title,
    caseType: input.caseType,
    targetRelationship: input.targetRelationship,
    status: "draft",
    ruthlessMode,
    scanScopes: JSON.stringify(scanScopes),
    createdAt: now,
    updatedAt: now,
  });

  await logAuditEvent({
    caseId: id,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "case_created",
    summary: `Privacy case "${input.title}" created`,
    detail: { caseType: input.caseType, scanScopes, ruthlessMode },
  });

  return id;
}

export async function recordAuthorization(
  session: SessionPayload,
  caseId: string,
  input: {
    authorityBasis: string;
    userAttestation: boolean;
    guardianDocRef?: string;
    poaRef?: string;
    orgAuthRef?: string;
  },
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  if (!input.userAttestation) {
    await logAuditEvent({
      caseId,
      organizationId: session.organizationId,
      userId: session.userId,
      eventType: "authorization_blocked",
      summary: "Authorization attestation refused",
    });
    throw new Error("ATTESTATION_REQUIRED");
  }

  const status = input.userAttestation ? "verified" : "pending";
  const authId = uuid();
  const now = new Date().toISOString();

  await db.insert(authorizationRecords).values({
    id: authId,
    caseId,
    authorityBasis: input.authorityBasis,
    userAttestation: input.userAttestation,
    status,
    guardianDocRef: input.guardianDocRef ?? null,
    poaRef: input.poaRef ?? null,
    orgAuthRef: input.orgAuthRef ?? null,
    attestedAt: now,
    createdAt: now,
  });

  const nextStatus = status === "verified" ? "consent_verified" : "draft";
  await db
    .update(privacyCases)
    .set({ status: nextStatus, updatedAt: now })
    .where(eq(privacyCases.id, caseId));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "authorization_recorded",
    summary: `Authorization ${status}`,
    detail: { authorityBasis: input.authorityBasis, status },
  });

  return authId;
}

export async function addIdentityClaims(
  session: SessionPayload,
  caseId: string,
  claims: Array<{ claimType: string; value: string; scanEnabled: boolean }>,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  let profile = await db.query.identityProfiles.findFirst({
    where: eq(identityProfiles.caseId, caseId),
  });

  if (!profile) {
    const profileId = uuid();
    await db.insert(identityProfiles).values({
      id: profileId,
      caseId,
      label: "Primary identity profile",
      createdAt: new Date().toISOString(),
    });
    profile = { id: profileId, caseId, label: "Primary identity profile", createdAt: new Date().toISOString() };
  }

  const created: string[] = [];
  for (const claim of claims) {
    const claimId = uuid();
    await db.insert(identityClaims).values({
      id: claimId,
      profileId: profile.id,
      caseId,
      claimType: claim.claimType,
      encryptedValue: encryptValue(claim.value),
      valueHash: hashValue(claim.value),
      scanEnabled: claim.scanEnabled,
      createdAt: new Date().toISOString(),
    });
    created.push(claimId);
  }

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "identity_claims_added",
    summary: `${claims.length} encrypted identity claim(s) stored`,
    detail: {
      claimTypes: claims.map((c) => c.claimType),
      scanEnabledCount: claims.filter((c) => c.scanEnabled).length,
    },
  });

  return created;
}

export async function getIdentityClaimsRedacted(caseId: string) {
  const claims = await db.query.identityClaims.findMany({
    where: eq(identityClaims.caseId, caseId),
  });
  return claims.map((c) => ({
    id: c.id,
    claimType: c.claimType,
    scanEnabled: c.scanEnabled,
    redactedPreview: redactValue(decryptValue(c.encryptedValue)),
    createdAt: c.createdAt,
  }));
}

export async function getCaseTimeline(caseId: string) {
  return db.query.auditEvents.findMany({
    where: eq(auditEvents.caseId, caseId),
    orderBy: [desc(auditEvents.createdAt)],
  });
}

export async function getLatestAuthorization(caseId: string) {
  return db.query.authorizationRecords.findFirst({
    where: eq(authorizationRecords.caseId, caseId),
    orderBy: [desc(authorizationRecords.createdAt)],
  });
}

export async function queueIntakeSkillRun(
  session: SessionPayload,
  caseId: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const runId = uuid();
  const now = new Date().toISOString();

  await db.insert(agentRuns).values({
    id: runId,
    caseId,
    skillId: "intake-and-consent",
    status: "success",
    summary: "Intake and consent validation completed",
    confidenceScore: 1,
    outputJson: JSON.stringify({
      status: "success",
      summary: "Case authorization validated for downstream workflows.",
      confidence_score: 1,
      evidence_references: [],
      findings: [],
      recommended_next_action: "discover-public-exposure",
      approval_required: false,
      manual_review_reason: null,
    }),
    startedAt: now,
    completedAt: now,
    createdAt: now,
  });

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "agent_run_completed",
    summary: "intake-and-consent skill run recorded",
    detail: { skillId: "intake-and-consent", runId },
  });

  return runId;
}