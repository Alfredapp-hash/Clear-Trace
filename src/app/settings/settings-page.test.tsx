import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => {
  class NavigationSignal extends Error {
    constructor(
      public kind: "redirect" | "notFound",
      public target?: string,
    ) {
      super(kind === "redirect" ? `NEXT_REDIRECT:${target}` : "NEXT_NOT_FOUND");
    }
  }
  return {
    NavigationSignal,
    usePathname: () => "/settings",
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
    redirect: (target: string) => {
      throw new NavigationSignal("redirect", target);
    },
    notFound: () => {
      throw new NavigationSignal("notFound");
    },
  };
});

import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { apiKeys, familyMembers, memberships, organizations, users } from "@/lib/db/schema";
import { createSession, type SessionPayload } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import SettingsPage from "./page";
import SettingsLayout from "./layout";
import SkillsPage from "../skills/page";
import SecurityPage from "../security/page";

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) =>
      token && name === "cleartrace_session" ? { name, value: token } : undefined,
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

interface Seeded {
  orgId: string;
  ownerToken: string;
  memberToken: string;
  ownerName: string;
  orgName: string;
}

async function seedOrgWithOwnerAndMember(): Promise<Seeded> {
  ensureDatabase();
  const suffix = uuid().slice(0, 8);
  const orgId = uuid();
  const ownerId = uuid();
  const memberId = uuid();
  const ownerName = `Ada Settings ${suffix}`;
  const orgName = `Lovelace Labs ${suffix}`;
  const passwordHash = await bcrypt.hash("settings-test-pass", 4);

  await db.insert(organizations).values({ id: orgId, name: orgName, slug: `ll-${suffix}` });
  await db.insert(users).values([
    { id: ownerId, email: `owner-${suffix}@test.local`, name: ownerName, passwordHash },
    { id: memberId, email: `member-${suffix}@test.local`, name: `Member ${suffix}`, passwordHash },
  ]);
  await db.insert(memberships).values([
    { id: uuid(), userId: ownerId, organizationId: orgId, role: "owner" },
    // Later createdAt so the founder fallback in isOrgAdmin never picks the member.
    {
      id: uuid(),
      userId: memberId,
      organizationId: orgId,
      role: "member",
      createdAt: "9999-12-31 00:00:00",
    },
  ]);

  const base = { organizationId: orgId, organizationName: orgName, role: "user" };
  const owner: SessionPayload = { ...base, userId: ownerId, email: `owner-${suffix}@test.local`, name: ownerName };
  const member: SessionPayload = {
    ...base,
    userId: memberId,
    email: `member-${suffix}@test.local`,
    name: `Member ${suffix}`,
  };
  return {
    orgId,
    ownerToken: await createSession(owner),
    memberToken: await createSession(member),
    ownerName,
    orgName,
  };
}

function textOfTestId(html: string, testId: string): string | null {
  const match = html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`));
  return match ? match[1]! : null;
}

describe("settings page (server render)", () => {
  let seeded: Seeded;
  const fetchSpy = vi.fn(() => {
    throw new Error("settings render must not call fetch");
  });
  const savedDevMode = process.env.DEVELOPER_MODE;

  beforeAll(async () => {
    seeded = await seedOrgWithOwnerAndMember();
  });

  beforeEach(() => {
    delete process.env.DEVELOPER_MODE;
    fetchSpy.mockClear();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedDevMode === undefined) delete process.env.DEVELOPER_MODE;
    else process.env.DEVELOPER_MODE = savedDevMode;
  });

  it("renders the real user and workspace names, never 'User' / 'Workspace' fallbacks", async () => {
    mockSessionCookie(seeded.ownerToken);
    // The shell (with the names) comes from the segment layout, which wraps the page.
    const html = renderToStaticMarkup(await SettingsLayout({ children: await SettingsPage() }));

    expect(textOfTestId(html, "shell-user-name")).toBe(seeded.ownerName);
    expect(textOfTestId(html, "shell-org-name")).toBe(seeded.orgName);
    expect(html).not.toMatch(/data-testid="shell-user-name"[^>]*>User</);
    expect(html).not.toMatch(/data-testid="shell-org-name"[^>]*>Workspace</);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders household members and API keys from the server (no mount-time requests needed)", async () => {
    const memberName = `Grace Household ${uuid().slice(0, 6)}`;
    const keyName = `Key ${uuid().slice(0, 6)}`;
    await db.insert(familyMembers).values({
      id: uuid(),
      organizationId: seeded.orgId,
      displayName: memberName,
      relationship: "spouse",
    });
    await db.insert(apiKeys).values({
      id: uuid(),
      organizationId: seeded.orgId,
      name: keyName,
      keyPrefix: "ct_live_test",
      keyHash: `hash-${uuid()}`,
      scopesJson: JSON.stringify(["cases:read"]),
    });

    mockSessionCookie(seeded.ownerToken);
    const ownerHtml = renderToStaticMarkup(await SettingsPage());
    expect(ownerHtml).toContain(memberName);
    expect(ownerHtml).toContain("Spouse / partner");
    expect(ownerHtml).toContain(keyName);

    // Standard members see household members but never the org's API keys.
    mockSessionCookie(seeded.memberToken);
    const memberHtml = renderToStaticMarkup(await SettingsPage());
    expect(memberHtml).toContain(memberName);
    expect(memberHtml).not.toContain(keyName);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("orders the anchored sections and puts Local-only AI first in Privacy & AI", async () => {
    mockSessionCookie(seeded.ownerToken);
    const html = renderToStaticMarkup(await SettingsPage());

    const order = ["connections", "privacy-ai", "protection", "household", "api", "workspace"].map(
      (id) => html.indexOf(`<section id="${id}"`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    const privacy = html.slice(order[1], order[2]);
    const localOnly = privacy.indexOf("Local-only AI");
    expect(localOnly).toBeGreaterThan(-1);
    expect(localOnly).toBeLessThan(privacy.indexOf("AI model for drafts"));
    // The block moved out of the connector section.
    expect(html.slice(order[0], order[1])).not.toContain("Local-only AI");
  });

  it("renders Ongoing protection from the server: scheduled discovery off by default, with the quota warning", async () => {
    mockSessionCookie(seeded.ownerToken);
    const html = renderToStaticMarkup(await SettingsPage());
    const section = html.slice(
      html.indexOf('<section id="protection"'),
      html.indexOf('<section id="household"'),
    );
    expect(section).toContain("Ongoing protection");
    expect(section).toContain("Scheduled web discovery every 90 days");
    // Copy warns that it spends search quota and what is sent to the provider.
    expect(section).toContain("spends your SerpAPI / Google CSE quota");
    expect(section).toMatch(/sends the subject(&#x27;|')s name and city to that search provider/);
    expect(section).toMatch(/<input type="checkbox"[^>]*>/);
    expect(section).not.toMatch(/<input type="checkbox"[^>]*checked/);
    expect(section).toMatch(/id="scheduled-discovery-cap"[^>]*value="100"/);
    expect(html).toContain('href="#protection"');
    expect(fetchSpy).not.toHaveBeenCalled();

    await db
      .update(organizations)
      .set({
        agentDefaultsJson: JSON.stringify({
          scheduledDiscovery: true,
          scheduledDiscoveryMonthlyQueryCap: 250,
        }),
      })
      .where(eq(organizations.id, seeded.orgId));
    const onHtml = renderToStaticMarkup(await SettingsPage());
    const onSection = onHtml.slice(
      onHtml.indexOf('<section id="protection"'),
      onHtml.indexOf('<section id="household"'),
    );
    expect(onSection).toMatch(/<input type="checkbox"[^>]*checked/);
    expect(onSection).toMatch(/id="scheduled-discovery-cap"[^>]*value="250"/);
    // No discovery connector configured → the skip is explained up front.
    expect(onSection).toContain("scheduled discovery will be skipped");

    // Members see the state but cannot change it.
    mockSessionCookie(seeded.memberToken);
    const memberHtml = renderToStaticMarkup(await SettingsPage());
    const memberSection = memberHtml.slice(
      memberHtml.indexOf('<section id="protection"'),
      memberHtml.indexOf('<section id="household"'),
    );
    expect(memberSection).toMatch(/id="scheduled-discovery-cap"[^>]*disabled/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows Settings → Developer to an org owner but not to a standard member", async () => {
    mockSessionCookie(seeded.ownerToken);
    const ownerHtml = renderToStaticMarkup(await SettingsPage());
    expect(ownerHtml).toContain('<section id="developer"');
    expect(ownerHtml).toContain('href="/skills"');
    expect(ownerHtml).toContain('href="/security"');

    mockSessionCookie(seeded.memberToken);
    const memberHtml = renderToStaticMarkup(await SettingsPage());
    expect(memberHtml).not.toContain('<section id="developer"');
    expect(memberHtml).not.toContain('href="/skills"');
    expect(memberHtml).not.toContain('href="/security"');
    // Primary nav has no developer entries for anyone.
    expect(memberHtml).not.toMatch(/>Skills</);
    expect(memberHtml).not.toMatch(/>Sentinel</);
  });

  it("DEVELOPER_MODE=1 shows the Developer section to a standard member", async () => {
    process.env.DEVELOPER_MODE = "1";
    mockSessionCookie(seeded.memberToken);
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).toContain('<section id="developer"');
  });

  it("settings layout redirects a request without a valid session to login", async () => {
    mockSessionCookie(null);
    await expect(SettingsLayout({ children: null })).rejects.toMatchObject({
      kind: "redirect",
      target: "/api/auth/session-expired?from=%2Fsettings",
    });
  });

  it("server-gates /skills and /security for standard members (404)", async () => {
    mockSessionCookie(seeded.memberToken);
    await expect(SkillsPage()).rejects.toMatchObject({ kind: "notFound" });
    await expect(SecurityPage()).rejects.toMatchObject({ kind: "notFound" });
  });

  it("skills page says Autopilot, not the old runner name", async () => {
    mockSessionCookie(seeded.ownerToken);
    const html = renderToStaticMarkup(await SkillsPage());
    expect(html).toContain("Autopilot");
    // Built from parts so the repo-wide "no old runner name in src/app" grep stays clean.
    expect(html).not.toContain(["Her", "mes"].join(""));
  });

  it("security page renders for an owner but only operators get the run button", async () => {
    mockSessionCookie(seeded.ownerToken);
    const html = renderToStaticMarkup(await SecurityPage());
    expect(html).toContain("Sentinel release gate");
    expect(html).not.toContain(">Run release gate<");

    process.env.DEVELOPER_MODE = "1";
    const operatorHtml = renderToStaticMarkup(await SecurityPage());
    expect(operatorHtml).toContain(">Run release gate<");
  });

  it("redirects to /login without a session", async () => {
    mockSessionCookie(null);
    await expect(SettingsPage()).rejects.toMatchObject({ kind: "redirect" });
  });
});
