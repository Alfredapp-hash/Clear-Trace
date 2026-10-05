import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/routing/policy-reader", () => ({
  readPublicPolicySignals: vi.fn(async () => null),
}));

import { v4 as uuid } from "uuid";
import { ensureDatabase } from "@/lib/db/init";
import type { SessionPayload } from "@/lib/auth/session";
import { recomputeCaseStatus } from "@/lib/verification/service";
import { seedWorkflowUser } from "@/lib/verification/test-fixtures";
import {
  addLiveCheck,
  caseStatusOf,
  seedSentScenario,
} from "@/lib/remediation/follow-up-scenario.fixture";
import { buildCaseGuide, buildGuideInput } from "./service";

describe("case guide (server)", () => {
  let session: SessionPayload;
  const url = (label: string) => `https://www.spokeo.com/${label}-${uuid().slice(0, 6)}`;

  beforeAll(async () => {
    ensureDatabase();
    session = await seedWorkflowUser();
  });

  it("marks the certificate checklist done only when a live check confirms removal", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url("GuideRemoved")],
      status: "sent",
      sentDaysAgo: 20,
    });
    await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "removed");
    await recomputeCaseStatus(scenario.caseId, new Date().toISOString());
    expect(await caseStatusOf(scenario.caseId)).toBe("removed_confirmed");

    const input = await buildGuideInput(session, scenario.caseId);
    expect(input?.certificateIssuable).toBe(true);

    const guide = await buildCaseGuide(session, scenario.caseId);
    expect(guide?.recommendedSkillId).toBe("generate-removal-certificate");
    expect(guide?.currentStep?.checklist.every((item) => item.done)).toBe(true);
  });

  it("does not mark the certificate done from status alone", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url("GuideStatusOnly")],
      status: "removed_confirmed",
      sentDaysAgo: 20,
    });
    const guide = await buildCaseGuide(session, scenario.caseId);
    expect(guide?.recommendedSkillId).toBe("generate-removal-certificate");
    expect(guide?.currentStep?.checklist.some((item) => item.done)).toBe(false);
  });

  it("recommends follow-up-policy for partially_resolved when a follow-up is allowed", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url("GuideA"), url("GuideB")],
      status: "sent",
      sentDaysAgo: 16,
    });
    const [a, b] = scenario.exposureIds;
    await addLiveCheck(scenario.caseId, a!, "removed");
    await addLiveCheck(scenario.caseId, b!, "still_exposed");
    await recomputeCaseStatus(scenario.caseId, new Date().toISOString());
    expect(await caseStatusOf(scenario.caseId)).toBe("partially_resolved");

    const guide = await buildCaseGuide(session, scenario.caseId);
    expect(guide?.recommendedSkillId).toBe("follow-up-policy");
  });
});
