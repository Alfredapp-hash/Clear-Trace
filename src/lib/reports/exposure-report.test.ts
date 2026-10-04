import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const current = process.env.DATABASE_URL;
  if (!current || current.endsWith("data/cleartrace.db")) {
    const dir = process.env.TMPDIR ?? "/tmp";
    process.env.DATABASE_URL = `${dir.replace(/\/$/, "")}/cleartrace-exposure-${process.pid}-${Date.now()}.db`;
  }
});

import { v4 as uuid } from "uuid";
import { db, sqlite } from "@/lib/db";
import { ensureDatabase } from "@/lib/db/init";
import { exposureCandidates, familyMembers } from "@/lib/db/schema";
import { assessExposureImpact } from "@/lib/ux/impact-score";
import { seedTestCase, seedTestUser } from "@/lib/test/api-helpers";
import { buildExposureReport, reportableCandidates } from "./exposure-report";

describe("exposure report building blocks", () => {
  it("ranks broker URLs as higher impact", () => {
    const broker = assessExposureImpact({
      url: "https://www.spokeo.com/john-doe",
      sourceType: "data_broker",
    });
    expect(broker.label).not.toBe("low");
    expect(broker.factors.length).toBeGreaterThan(0);
  });

  it("drops rejected and already-confirmed candidates", () => {
    const out = reportableCandidates(
      [
        { id: "a", matchStatus: "unreviewed" },
        { id: "b", matchStatus: "rejected" },
        { id: "c", matchStatus: "confirmed_match" },
        { id: "d", matchStatus: "possible_match" },
      ],
      [{ candidateId: "d" }],
    );
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("buildExposureReport", () => {
  beforeAll(() => ensureDatabase());

  it("does not double count a confirmed candidate and its exposure; ignores cross-org family member", async () => {
    const fixture = await seedTestUser();
    const { caseId } = await seedTestCase(fixture);
    const scan = sqlite.prepare("SELECT id FROM scan_runs WHERE case_id = ?").get(caseId) as { id: string };
    await db.insert(exposureCandidates).values([
      { id: uuid(), caseId, scanRunId: scan.id, canonicalUrl: "https://a.example/x", sourceType: "web", matchStatus: "rejected" },
      { id: uuid(), caseId, scanRunId: scan.id, canonicalUrl: "https://b.example/y", sourceType: "web", matchStatus: "unreviewed" },
    ]);

    const other = await seedTestUser();
    const foreignMember = uuid();
    await db.insert(familyMembers).values({
      id: foreignMember,
      organizationId: other.orgId,
      displayName: "Foreign Person",
      relationship: "child",
    });
    sqlite.prepare("UPDATE privacy_cases SET family_member_id = ? WHERE id = ?").run(foreignMember, caseId);

    const report = await buildExposureReport(caseId, fixture.session);
    expect(report.summary.confirmed).toBe(1);
    expect(report.summary.candidates).toBe(1);
    expect(report.items).toHaveLength(2);
    expect(report.items.filter((i) => i.url === "https://www.spokeo.com/test-profile")).toHaveLength(1);
    expect(report.subjectLabel).toBeNull();
  });
});
