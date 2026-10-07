import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/protection/catalog", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/protection/catalog")>();
  return {
    ...real,
    // Pretend "zabasearch" is a CPPA-registry-only broker for these tests.
    isRegistryBroker: (id: string | null | undefined) => id === "zabasearch",
  };
});

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db, sqlite } from "@/lib/db";
import {
  brokerSweepMatches,
  brokerSweepRuns,
  optOutDispatches,
  slaDeadlines,
} from "@/lib/db/schema";
import { BROKER_UNIVERSE } from "@/lib/brokers/universe";
import type { SessionPayload } from "@/lib/auth/session";
import { seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";
import {
  dismissOptOutDispatch,
  listOptOutDispatches,
  queueOptOutDispatchesFromSweep,
} from "./dispatch";
import { runBrokerSweep } from "@/lib/enterprise/broker-sweep";
import { reviewCandidate } from "@/lib/discovery/service";
import { verifiedExposures } from "@/lib/db/schema";

/**
 * Make the INSERT of one specific row fail inside the write loop (a real mid-loop error,
 * raised by SQLite itself), run `fn`, then drop the trigger.
 */
async function failInsertOf(table: string, brokerId: string, fn: () => Promise<unknown>) {
  sqlite.exec(
    `CREATE TEMP TRIGGER inject_failure BEFORE INSERT ON ${table}
     WHEN NEW.broker_id = '${brokerId}'
     BEGIN SELECT RAISE(ABORT, 'INJECTED_FAILURE'); END;`,
  );
  try {
    await fn();
  } finally {
    sqlite.exec("DROP TRIGGER IF EXISTS inject_failure");
  }
}

function countRows(table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** A sweep run with `found` seen rows and `toCheck` unchecked rows (real broker ids). */
async function seedSweep(
  session: SessionPayload,
  caseId: string,
  found: string[],
  toCheck: string[],
) {
  const runId = uuid();
  await db.insert(brokerSweepRuns).values({
    id: runId,
    caseId,
    organizationId: session.organizationId,
    status: "completed",
    brokerCount: BROKER_UNIVERSE.length,
    matchCount: found.length + toCheck.length,
    completedAt: new Date().toISOString(),
  });
  const byId = new Map(BROKER_UNIVERSE.map((b) => [b.id, b]));
  for (const [ids, status] of [
    [found, "open"],
    [toCheck, "to_check"],
  ] as const) {
    for (const id of ids) {
      const b = byId.get(id)!;
      await db.insert(brokerSweepMatches).values({
        id: uuid(),
        sweepRunId: runId,
        brokerId: b.id,
        brokerName: b.name,
        domain: b.domain,
        matchReason: status === "open" ? "exposure_url_match" : "scope_broker_universe",
        matchConfidence: status === "open" ? 0.9 : 0,
        optOutUrl: b.optOutUrl ?? null,
        status,
      });
    }
  }
  return runId;
}

async function dispatchesOf(caseId: string) {
  return db.query.optOutDispatches.findMany({ where: eq(optOutDispatches.caseId, caseId) });
}

describe("queue opt-outs from a sweep", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  it("queues only seen brokers by default: 3 found + 50 to_check → 3 dispatches", async () => {
    const { caseId } = await seedWorkflowCase(session);
    const found = ["spokeo", "whitepages", "beenverified"];
    const toCheck = BROKER_UNIVERSE.map((b) => b.id)
      .filter((id) => !found.includes(id))
      .slice(0, 50);
    expect(toCheck).toHaveLength(50);
    await seedSweep(session, caseId, found, toCheck);

    const res = await queueOptOutDispatchesFromSweep(session, caseId);
    expect(res.created).toBe(3);
    expect((await dispatchesOf(caseId)).map((d) => d.brokerId).sort()).toEqual([...found].sort());
  });

  it("a dismissed broker can be re-queued by the user, but not by the automatic sweep path", async () => {
    const { caseId } = await seedWorkflowCase(session);
    await seedSweep(session, caseId, ["spokeo", "whitepages"], []);
    expect((await queueOptOutDispatchesFromSweep(session, caseId)).created).toBe(2);
    const spokeo = (await dispatchesOf(caseId)).find((d) => d.brokerId === "spokeo")!;
    await dismissOptOutDispatch(session, caseId, spokeo.id);

    // Automatic (monthly sweep): the user said no, so the dismissed broker stays skipped.
    const auto = await queueOptOutDispatchesFromSweep(session, caseId, { skipDismissed: true });
    expect(auto).toMatchObject({ created: 0, skippedExisting: 2 });

    // The user queues again: the dismissed broker comes back as pending_approval; the open
    // whitepages dispatch is never duplicated.
    const manual = await queueOptOutDispatchesFromSweep(session, caseId);
    expect(manual).toMatchObject({ created: 1, skippedExisting: 1 });
    const rows = await dispatchesOf(caseId);
    expect(rows.filter((d) => d.brokerId === "spokeo").map((d) => d.status).sort()).toEqual([
      "dismissed",
      "pending_approval",
    ]);
    expect(rows.filter((d) => d.brokerId === "whitepages")).toHaveLength(1);
  });

  it("includeUnchecked queues to_check rows too, but never registry brokers", async () => {
    const { caseId } = await seedWorkflowCase(session);
    await seedSweep(session, caseId, ["spokeo"], ["intelius", "zabasearch", "anywho"]);

    const res = await queueOptOutDispatchesFromSweep(session, caseId, { includeUnchecked: true });
    expect(res.created).toBe(3);
    expect(res.skippedRegistry).toBe(1);
    const brokers = (await dispatchesOf(caseId)).map((d) => d.brokerId).sort();
    expect(brokers).toEqual(["anywho", "intelius", "spokeo"]);
    expect(brokers).not.toContain("zabasearch");
  });

  it("fills exposureUrl (and the package) from the found match's exposure", async () => {
    const url = "https://www.spokeo.com/Jane-Q-Testperson/p42";
    const { caseId } = await seedWorkflowCase(session, { exposureUrls: [url] });
    await runBrokerSweep(session, caseId);

    await queueOptOutDispatchesFromSweep(session, caseId);
    const [d] = await listOptOutDispatches(caseId, session);
    expect(d).toMatchObject({
      brokerId: "spokeo",
      exposureUrl: url,
      relistedFromId: null,
      resubmitCount: 0,
      nextDueAt: null,
      lastSeenAt: null,
    });
    expect(d!.package.exposureUrl).toBe(url);
    expect(d!.package.copyBlock).toContain(url);
  });

  it("an exposure confirmed then undone (rejected) is not seen by the sweep and is never queued", async () => {
    const url = "https://www.spokeo.com/Someone-Else/p7";
    const { caseId, exposureIds } = await seedWorkflowCase(session, { exposureUrls: [url] });
    const exposure = await db.query.verifiedExposures.findFirst({
      where: eq(verifiedExposures.id, exposureIds[0]!),
    });
    // The Undo of "Confirm all above 90%": reject the confirmed candidate.
    const undo = await reviewCandidate(session, caseId, exposure!.candidateId, "reject");
    expect(undo).toMatchObject({ status: "rejected", exposureRejected: true });

    const sweep = await runBrokerSweep(session, caseId);
    const spokeo = sweep.matches.find((m) => m.brokerId === "spokeo");
    expect(spokeo?.status).not.toBe("open");
    expect(sweep.seenCount).toBe(0);

    const res = await queueOptOutDispatchesFromSweep(session, caseId);
    expect(res.created).toBe(0);
    expect(await dispatchesOf(caseId)).toHaveLength(0);
    const deadlines = await db.query.slaDeadlines.findMany({
      where: eq(slaDeadlines.caseId, caseId),
    });
    expect(deadlines).toHaveLength(0);
  });

  it.each(["dismissed", "false_positive", "removed_confirmed"])(
    "an exposure in status %s does not mark its broker seen",
    async (status) => {
      const url = `https://www.whitepages.com/name/Jane-${status}`;
      const { caseId, exposureIds } = await seedWorkflowCase(session, { exposureUrls: [url] });
      await db
        .update(verifiedExposures)
        .set({ status })
        .where(eq(verifiedExposures.id, exposureIds[0]!));
      const sweep = await runBrokerSweep(session, caseId);
      expect(sweep.matches.find((m) => m.brokerId === "whitepages")?.status).not.toBe("open");
      expect((await queueOptOutDispatchesFromSweep(session, caseId)).created).toBe(0);
    },
  );

  it("two queues never duplicate a broker and leave one pending broker_opt_out deadline", async () => {
    const { caseId } = await seedWorkflowCase(session);
    await seedSweep(session, caseId, ["spokeo", "whitepages"], []);

    const first = await queueOptOutDispatchesFromSweep(session, caseId);
    await seedSweep(session, caseId, ["spokeo", "whitepages", "beenverified"], []);
    const second = await queueOptOutDispatchesFromSweep(session, caseId);
    const third = await queueOptOutDispatchesFromSweep(session, caseId);

    expect(first.created).toBe(2);
    expect(second.created).toBe(1);
    expect(third.created).toBe(0);
    expect((await dispatchesOf(caseId)).map((d) => d.brokerId).sort()).toEqual([
      "beenverified",
      "spokeo",
      "whitepages",
    ]);
    const pending = await db.query.slaDeadlines.findMany({
      where: and(
        eq(slaDeadlines.caseId, caseId),
        eq(slaDeadlines.deadlineType, "broker_opt_out"),
        eq(slaDeadlines.status, "pending"),
      ),
    });
    expect(pending).toHaveLength(1);
  });

  it("treats a renamed broker id (spokeo2 → peoplesearch123) as the same broker", async () => {
    const { caseId } = await seedWorkflowCase(session);
    await db.insert(optOutDispatches).values({
      id: uuid(),
      caseId,
      organizationId: session.organizationId,
      brokerId: "spokeo2",
      brokerName: "PeopleSearch123",
      status: "completed",
    });
    await seedSweep(session, caseId, ["peoplesearch123"], []);
    expect((await queueOptOutDispatchesFromSweep(session, caseId)).created).toBe(0);
  });

  it("a broker sweep alone creates no broker_opt_out deadline", async () => {
    const { caseId } = await seedWorkflowCase(session, {
      exposureUrls: ["https://www.spokeo.com/x"],
    });
    await runBrokerSweep(session, caseId);
    const rows = await db.query.slaDeadlines.findMany({
      where: and(eq(slaDeadlines.caseId, caseId), eq(slaDeadlines.deadlineType, "broker_opt_out")),
    });
    expect(rows).toHaveLength(0);
  });
});

describe("mid-loop failures roll back", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  it("a throw part-way through a sweep leaves no run and no match rows", async () => {
    const { caseId } = await seedWorkflowCase(session);
    const before = countRows("broker_sweep_matches");
    // Fails on a mid-ranked in-scope broker, after earlier match rows were written.
    await failInsertOf("broker_sweep_matches", "peoplefinders", async () => {
      await expect(runBrokerSweep(session, caseId)).rejects.toThrow("INJECTED_FAILURE");
    });
    expect(
      await db.query.brokerSweepRuns.findMany({ where: eq(brokerSweepRuns.caseId, caseId) }),
    ).toHaveLength(0);
    expect(countRows("broker_sweep_matches")).toBe(before);
    // And the sweep works once the fault is gone.
    expect((await runBrokerSweep(session, caseId)).inScope).toBeGreaterThan(1);
  });

  it("a throw part-way through queueing leaves no dispatch rows and no deadline", async () => {
    const { caseId } = await seedWorkflowCase(session);
    await seedSweep(session, caseId, ["spokeo", "whitepages", "beenverified"], []);
    await failInsertOf("opt_out_dispatches", "beenverified", async () => {
      await expect(queueOptOutDispatchesFromSweep(session, caseId)).rejects.toThrow(
        "INJECTED_FAILURE",
      );
    });
    expect(await dispatchesOf(caseId)).toHaveLength(0);
    const deadlines = await db.query.slaDeadlines.findMany({
      where: eq(slaDeadlines.caseId, caseId),
    });
    expect(deadlines).toHaveLength(0);
    expect((await queueOptOutDispatchesFromSweep(session, caseId)).created).toBe(3);
  });
});
