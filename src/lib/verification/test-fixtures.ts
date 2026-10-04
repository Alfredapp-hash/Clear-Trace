/**
 * Test-only DB fixtures shared by Lane C workflow tests (verification, remediation,
 * opt-out, breach-intel). Not imported by application code.
 */
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  users,
  organizations,
  memberships,
  privacyCases,
  identityProfiles,
  identityClaims,
  scanRuns,
  exposureCandidates,
  verifiedExposures,
} from "@/lib/db/schema";
import { ensureDatabase } from "@/lib/db/init";
import { encryptValue, hashValue } from "@/lib/crypto/encryption";
import type { SessionPayload } from "@/lib/auth/session";

export async function seedWorkflowUser(): Promise<SessionPayload> {
  ensureDatabase();
  const suffix = uuid().slice(0, 8);
  const userId = uuid();
  const orgId = uuid();
  const email = `lanec-${suffix}@test.local`;
  await db.insert(users).values({
    id: userId,
    email,
    name: "Lane C Tester",
    passwordHash: "x",
    role: "user",
  });
  await db.insert(organizations).values({
    id: orgId,
    name: "Lane C Org",
    slug: `lanec-org-${suffix}`,
  });
  await db.insert(memberships).values({
    id: uuid(),
    userId,
    organizationId: orgId,
    role: "user",
  });
  return {
    userId,
    email,
    name: "Lane C Tester",
    organizationId: orgId,
    organizationName: "Lane C Org",
    role: "user",
  };
}

export interface SeededCase {
  caseId: string;
  scanRunId: string;
  exposureIds: string[];
}

export async function seedWorkflowCase(
  session: SessionPayload,
  opts: {
    scanMode?: "demo" | "live" | null;
    exposureUrls?: string[];
    status?: string;
    claims?: Array<{ claimType: string; value: string }>;
    scanScopes?: string[];
  } = {},
): Promise<SeededCase> {
  const caseId = uuid();
  const scanRunId = uuid();
  const now = new Date().toISOString();
  await db.insert(privacyCases).values({
    id: caseId,
    organizationId: session.organizationId,
    ownerUserId: session.userId,
    title: "Lane C case",
    caseType: "people_search",
    targetRelationship: "self",
    status: opts.status ?? "sent",
    scanScopes: JSON.stringify(opts.scanScopes ?? ["people_search"]),
    createdAt: now,
    updatedAt: now,
  });

  const profileId = uuid();
  await db.insert(identityProfiles).values({ id: profileId, caseId, label: "Primary", createdAt: now });
  for (const claim of opts.claims ?? [{ claimType: "full_name", value: "Jane Q Testperson" }]) {
    await db.insert(identityClaims).values({
      id: uuid(),
      profileId,
      caseId,
      claimType: claim.claimType,
      encryptedValue: encryptValue(claim.value),
      valueHash: hashValue(claim.value),
      scanEnabled: true,
      createdAt: now,
    });
  }

  const mode = opts.scanMode === undefined ? "live" : opts.scanMode;
  // A scan run row is required for candidates (FK); use breach_intel mode when the
  // caller wants "no discovery run" so the case is neither demo nor live.
  await db.insert(scanRuns).values({
    id: scanRunId,
    caseId,
    status: "completed",
    mode: mode ?? "breach_intel",
    completedAt: now,
    createdAt: now,
  });

  const exposureIds: string[] = [];
  for (const url of opts.exposureUrls ?? ["https://people.example.org/jane"]) {
    const candidateId = uuid();
    await db.insert(exposureCandidates).values({
      id: candidateId,
      caseId,
      scanRunId,
      canonicalUrl: url,
      sourceType: "people_search",
      matchStatus: "confirmed_match",
      confidenceScore: 0.9,
      reviewedAt: now,
      createdAt: now,
    });
    const exposureId = uuid();
    await db.insert(verifiedExposures).values({
      id: exposureId,
      caseId,
      candidateId,
      canonicalUrl: url,
      exposureClass: "people_search",
      status: "confirmed_exposure",
      sensitivity: "medium",
      informationSummary: "address, phone number",
      confirmedAt: now,
      createdAt: now,
    });
    exposureIds.push(exposureId);
  }

  return { caseId, scanRunId, exposureIds };
}

/** Minimal SafeFetchResult builder for mocked live checks. */
export function fakePage(
  statusCode: number,
  body: string,
  url = "https://people.example.org/jane",
) {
  return {
    finalUrl: url,
    redirectChain: [url],
    statusCode,
    contentType: "text/html",
    body,
    truncated: false,
  };
}

export const LONG_CLEAN_PAGE = `<html><body><main><h1>Search our directory</h1><p>${"We could not find a record matching this listing. Try another search or browse our directory of public records by state and city. ".repeat(
  4,
)}</p></main></body></html>`;

export const LISTING_PAGE = `<html><body><main><h1>Jane Q Testperson</h1><p>${"Age 41. Lives in Springfield. Relatives, phone number and address history available. ".repeat(
  3,
)}</p></main></body></html>`;
