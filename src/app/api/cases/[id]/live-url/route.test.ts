import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));
vi.mock("@/lib/tools/safe-fetch", () => ({
  safeFetchPublicPage: vi.fn(),
}));
vi.mock("@/lib/routing/policy-reader", () => ({
  readPublicPolicySignals: vi.fn(async () => null),
}));

import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { db, sqlite } from "@/lib/db";
import { authorizationRecords, exposureCandidates, privacyCases, verifiedExposures } from "@/lib/db/schema";
import { seedTestCase, seedTestUser, readJson, type TestUserFixture } from "@/lib/test/api-helpers";
import { POST as liveUrlPost } from "./route";
import { POST as lifecyclePost } from "../lifecycle/route";
import { PATCH as discoveryPatch } from "../discovery/route";
import { POST as runNextStepPost } from "../run-next-step/route";
import { getRecommendedSkillForCase } from "@/lib/coordinator/skill-runner";

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (token && name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function jsonRequest(url: string, method: string, body: Record<string, unknown>) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const addUrl = (caseId: string, url: string) =>
  liveUrlPost(jsonRequest(`http://localhost/api/cases/${caseId}/live-url`, "POST", { url }), ctx(caseId));
const lifecycle = (caseId: string, action: string) =>
  lifecyclePost(jsonRequest(`http://localhost/api/cases/${caseId}/lifecycle`, "POST", { action }), ctx(caseId));
const review = (caseId: string, candidateId: string, decision: "confirm" | "reject") =>
  discoveryPatch(
    jsonRequest(`http://localhost/api/cases/${caseId}/discovery`, "PATCH", { candidateId, decision }),
    ctx(caseId),
  );

function page(url: string, body: string) {
  return {
    finalUrl: url,
    redirectChain: [url],
    statusCode: 200,
    contentType: "text/html",
    body: `<html><body><main>${body}</main></body></html>`,
    truncated: false,
  };
}

async function consent(caseId: string) {
  await db.insert(authorizationRecords).values({
    id: uuid(),
    caseId,
    authorityBasis: "self",
    userAttestation: true,
    status: "verified",
    attestedAt: new Date().toISOString(),
  });
}

async function caseWithStatus(fixture: TestUserFixture, status: string, withConsent = true) {
  const { caseId, exposureId } = await seedTestCase(fixture);
  await db.update(privacyCases).set({ status }).where(eq(privacyCases.id, caseId));
  if (withConsent) await consent(caseId);
  return { caseId, exposureId };
}

async function statusOf(caseId: string) {
  return (await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) }))?.status;
}

describe("POST /api/cases/[id]/live-url", () => {
  let fixture: TestUserFixture;

  beforeAll(async () => {
    fixture = await seedTestUser();
    mockSessionCookie(fixture.token);
  });

  beforeEach(() => {
    // The route allows 10 live-url fetches per user per hour; each test starts fresh.
    sqlite.prepare("DELETE FROM rate_limit_events WHERE key = ?").run(`live-url:${fixture.userId}`);
    vi.mocked(safeFetchPublicPage).mockReset();
    vi.mocked(safeFetchPublicPage).mockImplementation(async (url: string) =>
      page(url, "Jane Doe lives at 1 Main St. Phone and relatives listed."),
    );
  });

  it("draft → pause → resume returns draft; then live-url is 403 NOT_CONSENTED with no fetch", async () => {
    const { caseId } = await caseWithStatus(fixture, "draft", false);
    expect((await lifecycle(caseId, "pause")).status).toBe(200);
    const resumed = await lifecycle(caseId, "resume");
    expect(await readJson(resumed)).toEqual({ status: "draft" });

    const res = await addUrl(caseId, "https://people.example.com/jane");
    expect(res.status).toBe(403);
    expect((await readJson(res)).code).toBe("NOT_CONSENTED");
    expect(safeFetchPublicPage).not.toHaveBeenCalled();
  });

  it("does not infer consent from status: consent_verified without a record is 403", async () => {
    const { caseId } = await caseWithStatus(fixture, "consent_verified", false);
    const res = await addUrl(caseId, "https://people.example.com/jane");
    expect(res.status).toBe(403);
    expect(safeFetchPublicPage).not.toHaveBeenCalled();
  });

  it.each(["paused", "archived"])("live-url on a %s case returns 409 with no fetch", async (status) => {
    const { caseId } = await caseWithStatus(fixture, status);
    const res = await addUrl(caseId, "https://people.example.com/jane");
    expect(res.status).toBe(409);
    expect((await readJson(res)).code).toBe("CASE_BLOCKED");
    expect(safeFetchPublicPage).not.toHaveBeenCalled();
    expect(await statusOf(caseId)).toBe(status);
  });

  it("a live-url confirm of an already-confirmed URL returns the same exposureId", async () => {
    // seedTestCase confirmed https://www.spokeo.com/test-profile
    const { caseId, exposureId } = await caseWithStatus(fixture, "confirmed_exposure");
    const res = await addUrl(caseId, "https://www.spokeo.com/test-profile");
    expect(res.status).toBe(200);
    const body = await readJson<{ candidateId: string; outcome: string; exposureId: string }>(res);
    expect(body.outcome).toBe("already_known");
    expect(body.exposureId).toBe(exposureId);

    const confirm = await review(caseId, body.candidateId, "confirm");
    expect(confirm.status).toBe(200);
    expect((await readJson(confirm)).exposureId).toBe(exposureId);
    const exposures = await db.query.verifiedExposures.findMany({ where: eq(verifiedExposures.caseId, caseId) });
    expect(exposures).toHaveLength(1);
  });

  it("removed_confirmed + live-url + confirm gives partially_resolved", async () => {
    const { caseId, exposureId } = await caseWithStatus(fixture, "removed_confirmed");
    await db.update(verifiedExposures).set({ status: "removed_confirmed" }).where(eq(verifiedExposures.id, exposureId));

    const res = await addUrl(caseId, "https://other-broker.example.com/jane-doe");
    expect(res.status).toBe(201);
    const body = await readJson<{ candidateId: string; outcome: string }>(res);
    expect(body.outcome).toBe("new");
    expect(await statusOf(caseId)).toBe("removed_confirmed");

    const confirm = await review(caseId, body.candidateId, "confirm");
    expect(confirm.status).toBe(200);
    expect((await readJson(confirm)).alreadyConfirmed).toBe(false);
    expect(await statusOf(caseId)).toBe("partially_resolved");
  });

  it("removed_confirmed + live-url + confirm → run-next-step resolves the new page's controller, then drafts", async () => {
    const { caseId, exposureId } = await caseWithStatus(fixture, "removed_confirmed");
    await db.update(verifiedExposures).set({ status: "removed_confirmed" }).where(eq(verifiedExposures.id, exposureId));

    const added = await readJson<{ candidateId: string }>(
      await addUrl(caseId, "https://www.whitepages.com/name/jane-doe-autopilot"),
    );
    expect((await review(caseId, added.candidateId, "confirm")).status).toBe(200);
    expect(await statusOf(caseId)).toBe("partially_resolved");

    const res = await runNextStepPost(
      new Request(`http://localhost/api/cases/${caseId}/run-next-step`, { method: "POST" }),
      ctx(caseId),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ skillId: string; status: string }>(res);
    expect(body.skillId).toBe("resolve-content-controller");
    expect(body.status).toBe("success");
    // The new page now has a controller and a remediation: the next step drafts its request.
    expect(await getRecommendedSkillForCase(fixture.session, caseId)).toBe("draft-removal-request");
  });

  it("adding the same pending URL twice refreshes the candidate instead of duplicating it", async () => {
    const { caseId } = await caseWithStatus(fixture, "candidate_review");
    const url = "https://dup.example.com/jane";
    const first = await readJson<{ candidateId: string }>(await addUrl(caseId, url));
    const second = await addUrl(caseId, url);
    expect(second.status).toBe(200);
    expect((await readJson(second)).candidateId).toBe(first.candidateId);
    const rows = await db.query.exposureCandidates.findMany({ where: eq(exposureCandidates.caseId, caseId) });
    expect(rows.filter((r) => r.canonicalUrl === url)).toHaveLength(1);
  });

  it("a rejected URL is not recreated unless its content changed", async () => {
    const { caseId } = await caseWithStatus(fixture, "candidate_review");
    const url = "https://rejected.example.com/jane";
    const first = await readJson<{ candidateId: string }>(await addUrl(caseId, url));
    expect((await review(caseId, first.candidateId, "reject")).status).toBe(200);

    const again = await addUrl(caseId, url);
    expect(again.status).toBe(200);
    expect(await readJson(again)).toMatchObject({ outcome: "previously_rejected", candidateId: first.candidateId });
    const countFor = async () =>
      (await db.query.exposureCandidates.findMany({ where: eq(exposureCandidates.caseId, caseId) })).filter(
        (r) => r.canonicalUrl === url,
      ).length;
    expect(await countFor()).toBe(1);

    vi.mocked(safeFetchPublicPage).mockImplementation(async (u: string) =>
      page(u, "Jane Doe — new listing with a different address and phone."),
    );
    const changed = await addUrl(caseId, url);
    expect(changed.status).toBe(201);
    expect((await readJson(changed)).outcome).toBe("new");
    expect(await countFor()).toBe(2);
  });
});
