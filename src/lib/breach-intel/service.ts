import { and, desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  breachFindings,
  breachScanRuns,
  exposureCandidates,
  identityClaims,
  scanRuns,
} from "@/lib/db/schema";
import { decryptValue, redactValue } from "@/lib/crypto/encryption";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireBillingFeature } from "@/lib/billing/service";
import { getOrgConnector, resolveBreachIntelConnector } from "@/lib/connectors/service";
import { getCaseForUser } from "@/lib/cases/service";
import type { SessionPayload } from "@/lib/auth/session";
import { DEMO_HIBP_BREACHES, queryHibpBreaches, type HibpBreach } from "./hibp-client";
import { breachResponsePlaybook } from "./playbook";

function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return redactValue(email);
  const visible = local.length <= 2 ? "*" : `${local.slice(0, 2)}***`;
  return `${visible}@${domain}`;
}

function breachCandidateUrl(breachName: string): string {
  return `hibp://breach/${encodeURIComponent(breachName)}`;
}

async function createBreachCandidate(
  caseId: string,
  scanRunId: string,
  breach: HibpBreach,
  identifierRedacted: string,
): Promise<string> {
  const candidateId = uuid();
  const now = new Date().toISOString();
  const dataSummary = breach.dataClasses.join(", ");

  await db.insert(exposureCandidates).values({
    id: candidateId,
    caseId,
    scanRunId,
    canonicalUrl: breachCandidateUrl(breach.name),
    sourceType: "breach_intel",
    title: breach.title,
    matchStatus: "probable_match",
    confidenceScore: breach.isVerified ? 0.95 : 0.75,
    corroboratingFactors: JSON.stringify([
      `HIBP breach: ${breach.name}`,
      `Data classes: ${dataSummary}`,
      `Identifier: ${identifierRedacted}`,
    ]),
    conflictingFactors: JSON.stringify([]),
    createdAt: now,
  });

  return candidateId;
}

export async function runBreachScan(
  session: SessionPayload,
  caseId: string,
): Promise<{
  scanRunId: string;
  mode: "live" | "demo";
  identifierCount: number;
  findingCount: number;
  findings: Array<{
    id: string;
    breachTitle: string;
    breachDate: string | null;
    dataClasses: string[];
    identifierRedacted: string;
    responseActions: ReturnType<typeof breachResponsePlaybook>;
  }>;
}> {
  await requireBillingFeature(session.organizationId, "breach_intel");

  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const scanScopes = JSON.parse(privacyCase.scanScopes) as string[];
  if (!scanScopes.includes("breach_intel")) {
    throw new Error("BREACH_INTEL_SCOPE_REQUIRED");
  }

  const claims = await db.query.identityClaims.findMany({
    where: and(
      eq(identityClaims.caseId, caseId),
      eq(identityClaims.scanEnabled, true),
      eq(identityClaims.claimType, "email"),
    ),
  });

  if (!claims.length) throw new Error("NO_EMAIL_CLAIMS");

  const connectorType = await resolveBreachIntelConnector(session.organizationId);
  const mode = connectorType ? "live" : "demo";
  let apiKey: string | null = null;

  if (mode === "live" && connectorType === "hibp") {
    const connector = await getOrgConnector(session.organizationId, "hibp");
    apiKey = connector?.credentials.apiKey ?? null;
    if (!apiKey) throw new Error("CONNECTOR_REQUIRED:hibp");
  }

  const scanRunId = uuid();
  const now = new Date().toISOString();

  await db.insert(scanRuns).values({
    id: scanRunId,
    caseId,
    status: "running",
    mode: "breach_intel",
    queryCount: claims.length,
    startedAt: now,
    createdAt: now,
  });

  await db.insert(breachScanRuns).values({
    id: scanRunId,
    caseId,
    organizationId: session.organizationId,
    mode,
    identifierCount: claims.length,
    status: "running",
    createdAt: now,
  });

  const output: Array<{
    id: string;
    breachTitle: string;
    breachDate: string | null;
    dataClasses: string[];
    identifierRedacted: string;
    responseActions: ReturnType<typeof breachResponsePlaybook>;
  }> = [];

  for (const claim of claims) {
    const email = decryptValue(claim.encryptedValue).trim();
    const identifierRedacted = redactEmail(email);

    const breaches =
      mode === "live" && apiKey
        ? await queryHibpBreaches(apiKey, email)
        : DEMO_HIBP_BREACHES;

    for (const breach of breaches) {
      const findingId = uuid();
      const candidateId = await createBreachCandidate(
        caseId,
        scanRunId,
        breach,
        identifierRedacted,
      );

      await db.insert(breachFindings).values({
        id: findingId,
        scanRunId,
        caseId,
        identifierType: "email",
        identifierRedacted,
        breachName: breach.name,
        breachTitle: breach.title,
        breachDate: breach.breachDate,
        domain: breach.domain,
        dataClassesJson: JSON.stringify(breach.dataClasses),
        pwnCount: breach.pwnCount,
        isSensitive: breach.isSensitive,
        candidateId,
        status: "open",
        createdAt: now,
      });

      output.push({
        id: findingId,
        breachTitle: breach.title,
        breachDate: breach.breachDate ?? null,
        dataClasses: breach.dataClasses,
        identifierRedacted,
        responseActions: breachResponsePlaybook(breach.dataClasses),
      });
    }
  }

  const completedAt = new Date().toISOString();
  await db
    .update(scanRuns)
    .set({
      status: "completed",
      candidateCount: output.length,
      completedAt,
    })
    .where(eq(scanRuns.id, scanRunId));

  await db
    .update(breachScanRuns)
    .set({
      status: "completed",
      findingCount: output.length,
      completedAt,
    })
    .where(eq(breachScanRuns.id, scanRunId));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "breach_scan_completed",
    summary: `Breach scan (${mode}): ${output.length} finding(s) across ${claims.length} email(s)`,
    detail: { scanRunId, mode, findingCount: output.length },
  });

  return {
    scanRunId,
    mode,
    identifierCount: claims.length,
    findingCount: output.length,
    findings: output,
  };
}

export async function getBreachScanData(caseId: string) {
  const runs = await db.query.breachScanRuns.findMany({
    where: eq(breachScanRuns.caseId, caseId),
    orderBy: [desc(breachScanRuns.createdAt)],
  });
  const findings = await db.query.breachFindings.findMany({
    where: eq(breachFindings.caseId, caseId),
    orderBy: [desc(breachFindings.createdAt)],
  });

  return {
    runs,
    findings: findings.map((f) => ({
      ...f,
      dataClasses: JSON.parse(f.dataClassesJson) as string[],
      responseActions: breachResponsePlaybook(JSON.parse(f.dataClassesJson) as string[]),
    })),
  };
}