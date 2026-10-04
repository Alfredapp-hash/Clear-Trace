import { describe, expect, it, beforeAll } from "vitest";
import { v4 as uuid } from "uuid";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { organizations, users, memberships } from "@/lib/db/schema";
import { createPrivacyCase } from "@/lib/cases/service";
import { runBrokerSweep } from "./broker-sweep";
import type { SessionPayload } from "@/lib/auth/session";

describe("broker sweep", () => {
  const suffix = uuid().slice(0, 8);
  const userId = uuid();
  const orgId = uuid();
  let caseId = "";
  let session: SessionPayload;

  beforeAll(async () => {
    ensureDatabase();
    await db.insert(users).values({
      id: userId,
      email: `sweep-${suffix}@test.local`,
      name: "Sweep Tester",
      passwordHash: "x",
      role: "user",
    });
    await db.insert(organizations).values({
      id: orgId,
      name: "Sweep Org",
      slug: `sweep-org-${suffix}`,
    });
    await db.insert(memberships).values({
      id: uuid(),
      userId,
      organizationId: orgId,
      role: "user",
    });

    session = {
      userId,
      email: `sweep-${suffix}@test.local`,
      name: "Sweep Tester",
      organizationId: orgId,
      organizationName: "Sweep Org",
      role: "user",
    };

    caseId = await createPrivacyCase(session, {
      title: "Broker sweep case",
      caseType: "personal_exposure",
      targetRelationship: "self",
      scanScopes: ["people_search"],
    });
  });

  it("returns broker matches for a case", async () => {
    const result = await runBrokerSweep(session, caseId);
    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.matches[0]?.optOutUrl || result.matches[0]?.domain).toBeTruthy();
  });

  it("unseen brokers are to_check with no match confidence", async () => {
    const result = await runBrokerSweep(session, caseId);
    // case has no exposures/candidates → nothing was actually seen
    expect(result.seenCount).toBe(0);
    for (const m of result.matches) {
      expect(m.status).toBe("to_check");
      expect(m.matchConfidence).toBe(0);
    }
  });
});