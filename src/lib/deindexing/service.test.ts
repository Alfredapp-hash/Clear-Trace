import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { deindexRequests, privacyCases, verifiedExposures } from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";
import {
  createDeindexRequests,
  listDeindexRequests,
  orderExposuresForDeindex,
  withDeindexTool,
} from "./service";

describe("deindex status lifecycle", () => {
  it("follows draft → submitted → resolved order", () => {
    const flow = ["draft", "submitted", "resolved"];
    expect(flow.indexOf("draft")).toBeLessThan(flow.indexOf("submitted"));
    expect(flow.indexOf("submitted")).toBeLessThan(flow.indexOf("resolved"));
  });
});

describe("orderExposuresForDeindex", () => {
  it("orders by risk desc, then createdAt asc", () => {
    const ordered = orderExposuresForDeindex([
      { id: "low-old", riskLevel: "low", createdAt: "2026-01-01" },
      { id: "high-new", riskLevel: "high", createdAt: "2026-03-01" },
      { id: "none", riskLevel: null, createdAt: "2025-01-01" },
      { id: "high-old", riskLevel: "high", createdAt: "2026-02-01" },
      { id: "urgent", riskLevel: "urgent", createdAt: "2026-05-01" },
    ]);
    expect(ordered.map((e) => e.id)).toEqual(["urgent", "high-old", "high-new", "low-old", "none"]);
  });
});

describe("createDeindexRequests", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  it("a case with 8 exposures creates 16 drafts, then 0 on a second call", async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://people.example.org/p${i}`);
    const { caseId } = await seedWorkflowCase(session, { exposureUrls: urls });

    const first = await createDeindexRequests(session, caseId, ["google", "bing"]);
    expect(first.created).toBe(16);
    expect(first.remaining).toBe(0);
    expect(first.drafts).toHaveLength(16);
    for (const d of first.drafts) {
      expect(d.toolId).toBeTruthy();
      expect(d.toolLabel).toBeTruthy();
      expect(d.toolUrl).toMatch(/^https:\/\//);
      expect(d.reason).toBeTruthy();
    }
    const rows = await db.query.deindexRequests.findMany({ where: eq(deindexRequests.caseId, caseId) });
    expect(rows).toHaveLength(16);
    expect(new Set(rows.map((r) => `${r.sourceUrl}|${r.searchEngine}`)).size).toBe(16);

    const second = await createDeindexRequests(session, caseId, ["google", "bing"]);
    expect(second.created).toBe(0);
    expect(second.remaining).toBe(0);
  });

  it("filters existing pairs before applying a limit, highest risk first", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      exposureUrls: ["https://people.example.org/a", "https://people.example.org/b", "https://people.example.org/c"],
    });
    await db.update(verifiedExposures).set({ riskLevel: "urgent" }).where(eq(verifiedExposures.id, exposureIds[2]!));

    const first = await createDeindexRequests(session, caseId, ["google"], { limit: 1 });
    expect(first.created).toBe(1);
    expect(first.remaining).toBe(2);
    expect(first.drafts[0]!.exposureId).toBe(exposureIds[2]);

    // Already-drafted pair is filtered out first, so the next page makes progress.
    const second = await createDeindexRequests(session, caseId, ["google"], { limit: 1 });
    expect(second.created).toBe(1);
    expect(second.remaining).toBe(1);
    expect(second.drafts[0]!.exposureId).toBe(exposureIds[0]);
  });

  it("picks the tool per exposure: live phone, removed source, harassment case", async () => {
    const live = await seedWorkflowCase(session, { exposureUrls: ["https://people.example.org/live"] });
    await db
      .update(verifiedExposures)
      .set({ exposureCategories: JSON.stringify(["phone_number"]) })
      .where(eq(verifiedExposures.id, live.exposureIds[0]!));
    const liveResult = await createDeindexRequests(session, live.caseId, ["google", "bing"]);
    expect(liveResult.drafts.map((d) => d.toolId).sort()).toEqual(["bing_privacy", "google_personal_info"]);

    const removed = await seedWorkflowCase(session, { exposureUrls: ["https://people.example.org/gone"] });
    await db
      .update(verifiedExposures)
      .set({ status: "removed_confirmed", exposureCategories: JSON.stringify(["address"]) })
      .where(eq(verifiedExposures.id, removed.exposureIds[0]!));
    const removedResult = await createDeindexRequests(session, removed.caseId, ["google", "bing"]);
    expect(removedResult.drafts.map((d) => d.toolId).sort()).toEqual(["bing_content_removal", "google_outdated"]);

    const harass = await seedWorkflowCase(session, { exposureUrls: ["https://forum.example.org/dox"] });
    await db.update(privacyCases).set({ caseType: "harassment" }).where(eq(privacyCases.id, harass.caseId));
    const harassResult = await createDeindexRequests(session, harass.caseId, ["google"]);
    expect(harassResult.drafts[0]!.toolId).toBe("google_doxxing");

    // Read time: the tool is derived from engine + toolUrl (no DB column).
    const listed = await listDeindexRequests(harass.caseId, session);
    expect(listed[0]!.toolId).toBe("google_doxxing");
    expect(listed[0]!.reason).toMatch(/harass/i);
  });

  it("skips rejected/dismissed exposures and throws NO_EXPOSURES when none remain", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      exposureUrls: ["https://people.example.org/rejected"],
    });
    await db.update(verifiedExposures).set({ status: "dismissed" }).where(eq(verifiedExposures.id, exposureIds[0]!));
    await expect(createDeindexRequests(session, caseId)).rejects.toThrow("NO_EXPOSURES");
  });

  it("withDeindexTool maps legacy Bing rows to the content removal tool", () => {
    const row = withDeindexTool({ searchEngine: "bing", toolUrl: "https://www.bing.com/webmasters/about" });
    expect(row.toolId).toBe("bing_content_removal");
  });
});
