import { describe, expect, it, beforeAll, vi } from "vitest";

vi.mock("@/lib/drafting/llm-polish", () => ({
  optionalPolishDraft: vi.fn(async (_org: string, subject: string, body: string) => ({
    subject,
    body,
    polished: false,
  })),
}));
vi.mock("@/lib/routing/policy-reader", () => ({
  readPublicPolicySignals: vi.fn(async () => null),
}));

import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import {
  users,
  organizations,
  memberships,
  privacyCases,
  identityProfiles,
  identityClaims,
  messageDrafts,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { encryptValue, hashValue } from "@/lib/crypto/encryption";
import { getRecommendedSkillForCase, runNextSkill } from "./skill-runner";
import type { SessionPayload } from "@/lib/auth/session";
import { recomputeCaseStatus } from "@/lib/verification/service";
import {
  createRemovalDraft,
  getRemediationData,
  resolveControllerForExposure,
} from "@/lib/remediation/service";
import { seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";
import {
  addLiveCheck,
  addVerifiedAuthorization,
  caseStatusOf,
  seedSentScenario,
  setCaseStatus,
} from "@/lib/remediation/follow-up-scenario.fixture";

describe("skill runner", () => {
  const suffix = uuid().slice(0, 8);
  const userId = uuid();
  const orgId = uuid();
  const activeCaseId = uuid();
  const pausedCaseId = uuid();
  const email = `runner-${suffix}@test.local`;

  const session: SessionPayload = {
    userId,
    email,
    name: "Runner",
    organizationId: orgId,
    organizationName: "Runner Org",
    role: "user",
  };

  beforeAll(async () => {
    ensureDatabase();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: userId,
      email,
      name: "Runner",
      passwordHash: "x",
      role: "user",
    });
    await db.insert(organizations).values({
      id: orgId,
      name: "Runner Org",
      slug: `runner-org-${suffix}`,
    });
    await db.insert(memberships).values({
      id: uuid(),
      userId,
      organizationId: orgId,
      role: "user",
    });
    const profileId = uuid();
    await db.insert(privacyCases).values([
      {
        id: activeCaseId,
        organizationId: orgId,
        ownerUserId: userId,
        title: "Active case",
        caseType: "people_search",
        targetRelationship: "self",
        status: "consent_verified",
        scanScopes: "[]",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: pausedCaseId,
        organizationId: orgId,
        ownerUserId: userId,
        title: "Paused case",
        caseType: "people_search",
        targetRelationship: "self",
        status: "paused",
        scanScopes: "[]",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(identityProfiles).values({
      id: profileId,
      caseId: activeCaseId,
      label: "Primary",
      createdAt: now,
    });
    await db.insert(identityClaims).values({
      id: uuid(),
      profileId,
      caseId: activeCaseId,
      claimType: "full_name",
      encryptedValue: encryptValue("Jane Doe"),
      valueHash: hashValue("Jane Doe"),
      scanEnabled: true,
      createdAt: now,
    });
    // Discovery requires a verified authorization record (consent is never inferred).
    await addVerifiedAuthorization(activeCaseId);
  });

  it("runs discovery for consent_verified cases", async () => {
    const result = await runNextSkill(session, activeCaseId);
    expect(result.skillId).toBe("discover-public-exposure");
    expect(result.status).toBe("success");
    expect(result.runId).toBeTruthy();
  });

  it("reports discovery as blocked (not an error) without a verified authorization", async () => {
    const unconsentedId = uuid();
    const now = new Date().toISOString();
    await db.insert(privacyCases).values({
      id: unconsentedId,
      organizationId: orgId,
      ownerUserId: userId,
      title: "No consent record",
      caseType: "people_search",
      targetRelationship: "self",
      status: "consent_verified",
      scanScopes: "[]",
      createdAt: now,
      updatedAt: now,
    });
    const result = await runNextSkill(session, unconsentedId);
    expect(result.skillId).toBe("discover-public-exposure");
    expect(result.status).toBe("blocked");
    expect(result.summary).toMatch(/authorization/i);
    expect(result.output).toMatchObject({ code: "NOT_CONSENTED" });
  });

  it("blocks paused cases", async () => {
    await expect(runNextSkill(session, pausedCaseId)).rejects.toThrow("CASE_BLOCKED");
  });

  it("rejects unknown cases", async () => {
    await expect(runNextSkill(session, uuid())).rejects.toThrow("CASE_NOT_FOUND");
  });
});

describe("Autopilot: follow-ups and certificates", () => {
  let session: SessionPayload;
  const url = (label: string) => `https://www.spokeo.com/${label}-${uuid().slice(0, 6)}`;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  async function followUpDraftsFor(caseId: string) {
    const drafts = await db.query.messageDrafts.findMany({
      where: eq(messageDrafts.caseId, caseId),
    });
    return drafts.filter((d) => d.isFollowUp);
  }

  it("A removed + B still exposed (sent 15+ days ago): partially_resolved, follows up on B only", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url("Removed-A"), url("Visible-B")],
      status: "sent",
      sentDaysAgo: 16,
    });
    const [exposureA, exposureB] = scenario.exposureIds;
    const [, remediationB] = scenario.remediationIds;
    await addLiveCheck(scenario.caseId, exposureA!, "removed");
    await addLiveCheck(scenario.caseId, exposureB!, "still_exposed");
    await recomputeCaseStatus(scenario.caseId, new Date().toISOString());
    expect(await caseStatusOf(scenario.caseId)).toBe("partially_resolved");

    // The GET payload shows the follow-up as allowed for B (and nothing for A).
    const before = await getRemediationData(scenario.caseId, session);
    const b = before.remediations.find((r) => r.id === remediationB);
    expect(b?.followUp?.allowed).toBe(true);
    expect(before.remediations.filter((r) => r.followUp !== null)).toHaveLength(1);

    expect(await getRecommendedSkillForCase(session, scenario.caseId)).toBe("follow-up-policy");
    const result = await runNextSkill(session, scenario.caseId);
    expect(result.skillId).toBe("follow-up-policy");
    expect(result.status).toBe("success");

    const followUps = await followUpDraftsFor(scenario.caseId);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.remediationCaseId).toBe(remediationB);
    // The follow-up never resets the case.
    expect(await caseStatusOf(scenario.caseId)).toBe("partially_resolved");

    // Running again does not draft a second follow-up while the first is unsent.
    expect(await getRecommendedSkillForCase(session, scenario.caseId)).toBe("verify-removal");
  });

  it("follow-up-policy drafts for every eligible remediation, not just the first", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url("Visible-B"), url("Visible-C")],
      status: "follow_up_eligible",
      sentDaysAgo: 20,
    });
    for (const exposureId of scenario.exposureIds) {
      await addLiveCheck(scenario.caseId, exposureId, "still_exposed");
    }
    const result = await runNextSkill(session, scenario.caseId);
    expect(result.skillId).toBe("follow-up-policy");
    expect(result.status).toBe("success");
    const followUps = await followUpDraftsFor(scenario.caseId);
    expect(new Set(followUps.map((d) => d.remediationCaseId))).toEqual(
      new Set(scenario.remediationIds),
    );
  });

  it("follow-up-policy creates nothing while the waiting period runs", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url("Recent")],
      status: "follow_up_eligible",
      sentDaysAgo: 1,
    });
    await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "still_exposed");
    const result = await runNextSkill(session, scenario.caseId);
    expect(result.skillId).toBe("follow-up-policy");
    expect(result.status).toBe("manual_review_required");
    expect(result.output.nextEligibleDate).toBeTruthy();
    expect(await followUpDraftsFor(scenario.caseId)).toHaveLength(0);
  });

  it("partially_resolved with nothing eligible recommends verify-removal", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url("Removed-A"), url("Recent-B")],
      status: "sent",
      sentDaysAgo: 2,
    });
    await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "removed");
    await addLiveCheck(scenario.caseId, scenario.exposureIds[1]!, "still_exposed");
    await recomputeCaseStatus(scenario.caseId, new Date().toISOString());
    expect(await caseStatusOf(scenario.caseId)).toBe("partially_resolved");
    expect(await getRecommendedSkillForCase(session, scenario.caseId)).toBe("verify-removal");
  });

  it("Run-next-step on removed_confirmed returns the certificate skill (issuable)", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url("Removed")],
      status: "sent",
      sentDaysAgo: 20,
    });
    await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "removed");
    await recomputeCaseStatus(scenario.caseId, new Date().toISOString());
    expect(await caseStatusOf(scenario.caseId)).toBe("removed_confirmed");

    expect(await getRecommendedSkillForCase(session, scenario.caseId)).toBe(
      "generate-removal-certificate",
    );
    const result = await runNextSkill(session, scenario.caseId);
    expect(result.skillId).toBe("generate-removal-certificate");
    expect(result.status).toBe("success");
    expect(result.output.certificateIssuable).toBe(true);
    expect(await followUpDraftsFor(scenario.caseId)).toHaveLength(0);
  });

  it("does not claim a certificate when no live check confirms the removal", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url("NoLiveCheck")],
      status: "removed_confirmed",
      sentDaysAgo: 20,
    });
    const result = await runNextSkill(session, scenario.caseId);
    expect(result.skillId).toBe("generate-removal-certificate");
    expect(result.status).toBe("manual_review_required");
    expect(result.output.certificateIssuable).toBe(false);
    expect(result.output.certificateUrl).toBeNull();
  });

  it("returns null / CASE_BLOCKED for paused cases", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url("Paused")],
      status: "paused",
      sentDaysAgo: 20,
    });
    expect(await getRecommendedSkillForCase(session, scenario.caseId)).toBeNull();
    await expect(runNextSkill(session, scenario.caseId)).rejects.toThrow("CASE_BLOCKED");
  });

  it("compliance step advances draft_ready forward only", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url("Compliance")],
      status: "draft_ready",
      sentDaysAgo: 20,
    });
    // Give it a fresh unsent draft to check.
    await db
      .update(messageDrafts)
      .set({ status: "awaiting_user_approval" })
      .where(eq(messageDrafts.id, scenario.draftIds[0]!));
    const result = await runNextSkill(session, scenario.caseId);
    expect(result.skillId).toBe("compliance-verify-draft");
    const status = await caseStatusOf(scenario.caseId);
    expect(status).toBe(result.status === "success" ? "approved_to_send" : "draft_ready");
    expect(result.output.case_status).toBe(status);
  });

  it("status-only lookups stay consistent for partially_resolved", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url("NoChecks")],
      status: "partially_resolved",
      sentDaysAgo: 20,
    });
    // No live check says "still exposed" → nothing eligible → verify-removal.
    expect(await getRecommendedSkillForCase(session, scenario.caseId)).toBe("verify-removal");
    await setCaseStatus(scenario.caseId, "closed");
    expect(await getRecommendedSkillForCase(session, scenario.caseId)).toBeNull();
  });
});

describe("Autopilot: no duplicate drafts", () => {
  let session: SessionPayload;
  const url = (label: string) => `https://www.spokeo.com/${label}-${uuid().slice(0, 6)}`;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  async function draftCount(caseId: string) {
    return (await db.query.messageDrafts.findMany({ where: eq(messageDrafts.caseId, caseId) })).length;
  }

  it("Run-next-step at remedy_selected with existing drafts makes no new draft", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      status: "confirmed_exposure",
      exposureUrls: [url("NoDup")],
    });
    const resolved = await resolveControllerForExposure(session, caseId, exposureIds[0]!);
    await createRemovalDraft(session, caseId, resolved.remediationId);
    await setCaseStatus(caseId, "remedy_selected");
    expect(await draftCount(caseId)).toBe(1);

    const result = await runNextSkill(session, caseId);
    expect(result.skillId).toBe("draft-removal-request");
    expect(result.summary).toMatch(/nothing to draft/i);
    expect(result.output.drafts).toEqual([]);
    expect(await draftCount(caseId)).toBe(1);
    // The case catches up so the next step reviews the existing draft.
    expect(await caseStatusOf(caseId)).toBe("draft_ready");
  });

  it("drafts only the remediations that have no live draft", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      status: "confirmed_exposure",
      exposureUrls: [url("HasDraft"), url("NoDraft")],
    });
    const a = await resolveControllerForExposure(session, caseId, exposureIds[0]!);
    await resolveControllerForExposure(session, caseId, exposureIds[1]!);
    await createRemovalDraft(session, caseId, a.remediationId);
    await setCaseStatus(caseId, "remedy_selected");
    const result = await runNextSkill(session, caseId);
    expect((result.output.drafts as unknown[]).length).toBe(1);
    expect(await draftCount(caseId)).toBe(2);
  });

  it("compliance-verify-draft checks the newest awaiting draft", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      status: "confirmed_exposure",
      exposureUrls: [url("Newest")],
    });
    const resolved = await resolveControllerForExposure(session, caseId, exposureIds[0]!);
    const older = await createRemovalDraft(session, caseId, resolved.remediationId);
    const newer = await createRemovalDraft(session, caseId, resolved.remediationId);
    // Older draft carries prohibited language; the newest is clean.
    await db
      .update(messageDrafts)
      .set({ body: "Remove this or else we file a lawsuit.", createdAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(messageDrafts.id, older.draftId));
    await setCaseStatus(caseId, "draft_ready");
    const result = await runNextSkill(session, caseId);
    expect(result.skillId).toBe("compliance-verify-draft");
    expect(result.output.warnings).toEqual([]);
    expect(newer.draftId).toBeTruthy();
  });
});
