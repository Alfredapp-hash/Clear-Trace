import Link from "next/link";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AgentBuilderKit } from "@/components/AgentBuilderKit";
import { AgentSetupGuide } from "@/components/AgentSetupGuide";
import { ConnectorSettings, type ConnectorSettingsData } from "@/components/ConnectorSettings";
import { EnterpriseSettings } from "@/components/EnterpriseSettings";
import { requireBillingFeature } from "@/lib/billing/service";
import type { BillingFeature } from "@/lib/billing/plans";
import { listApiKeys } from "@/lib/enterprise/api-keys";
import { listEnterpriseWebhooks } from "@/lib/enterprise/webhooks";
import { getFamilySeatLimit, listFamilyMembers } from "@/lib/family/service";
import { FamilySettings } from "@/components/FamilySettings";
import { PrivacyAiSection, WorkspaceSection } from "@/components/settings/PrivacyAiSection";
import { ProtectionSettings } from "@/components/settings/ProtectionSettings";
import { getScheduledDiscoveryStatus } from "@/lib/protection/runner";
import { Card, PageHeader } from "@/components/ui";
import { canAccessDeveloperTools, getSession } from "@/lib/auth/session";
import { isOrgAdmin } from "@/lib/auth/org-role";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import {
  getAgentDefaults,
  getConnectorHealth,
  getSetupGuide,
  listOrgConnectors,
} from "@/lib/connectors/service";

/** Sticky in-page navigation targets, in page order. */
const SECTIONS = [
  { id: "connections", label: "Search & email connections" },
  { id: "privacy-ai", label: "Privacy & AI" },
  { id: "protection", label: "Ongoing protection" },
  { id: "household", label: "Household" },
  { id: "api", label: "API & integrations" },
  { id: "workspace", label: "Workspace" },
] as const;

const DEVELOPER_SECTION = { id: "developer", label: "Developer" } as const;

/**
 * Same data as GET /api/settings/api-keys and /webhooks: only org owners/admins on a plan
 * with the feature see rows (the routes answer 403 / 402 otherwise, which the client shows
 * as an empty list).
 */
async function listIfAllowed<T>(
  canManage: boolean,
  orgId: string,
  feature: BillingFeature,
  load: () => Promise<T[]>,
): Promise<T[]> {
  if (!canManage) return [];
  try {
    await requireBillingFeature(orgId, feature);
  } catch (error) {
    if (error instanceof Error && error.message === "BILLING_UPGRADE_REQUIRED") return [];
    throw error;
  }
  return load();
}

function SectionHeading({ id, title, subtitle }: { id: string; title: string; subtitle?: string }) {
  return (
    <div className="mb-5">
      <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight text-white">
        {title}
      </h2>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
    </div>
  );
}

/**
 * Settings is a Server Component: the session, connector status, agent defaults and org
 * settings are read here and handed to the client islands as props, so the page needs no
 * data requests after hydration for these sections.
 */
export default async function SettingsPage() {
  ensureDatabase();
  const session = await getSession();
  if (!session) redirect("/login?from=/settings");

  const orgId = session.organizationId;
  const [connectors, health, agentDefaults, canManage, showDeveloper, org] = await Promise.all([
    listOrgConnectors(orgId),
    getConnectorHealth(orgId),
    getAgentDefaults(orgId),
    isOrgAdmin(session.userId, orgId),
    canAccessDeveloperTools(session),
    db.query.organizations.findFirst({ where: eq(organizations.id, orgId) }),
  ]);

  const [familyMembers, familySeatLimit, apiKeys, webhooks, scheduledDiscovery] = await Promise.all([
    listFamilyMembers(orgId).then((rows) =>
      rows.map(({ id, displayName, relationship, notes }) => ({ id, displayName, relationship, notes })),
    ),
    getFamilySeatLimit(orgId),
    listIfAllowed(canManage, orgId, "api_keys", () => listApiKeys(orgId)),
    listIfAllowed(canManage, orgId, "enterprise_webhooks", () => listEnterpriseWebhooks(orgId)),
    getScheduledDiscoveryStatus(orgId),
  ]);

  const connectorData: ConnectorSettingsData = {
    connectors,
    health,
    agentDefaults,
    setupGuides: Object.fromEntries(connectors.map((c) => [c.type, getSetupGuide(c.type)])),
    canManage,
  };

  const intelligenceOptions = connectors
    .filter((c) => c.category === "intelligence")
    .map((c) => ({ type: c.type, name: c.name }));

  const sections = showDeveloper ? [...SECTIONS, DEVELOPER_SECTION] : [...SECTIONS];

  return (
    <AppShell userName={session.name} orgName={session.organizationName}>
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        description="Connect your own search and email accounts, choose how AI is used, and manage your household and workspace."
      />

      <nav
        aria-label="Settings sections"
        className="sticky top-[6.5rem] z-40 -mx-2 mb-8 flex gap-1 overflow-x-auto rounded-xl border border-white/[0.06] bg-[#08090d]/90 p-1.5 backdrop-blur-xl md:top-[4.5rem]"
      >
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-300 transition hover:bg-white/[0.06] hover:text-white"
          >
            {section.label}
          </a>
        ))}
      </nav>

      <div className="space-y-14">
        <section id="connections" aria-labelledby="connections-heading" className="ct-anchor-section">
          <SectionHeading
            id="connections"
            title="Search & email connections"
            subtitle="Bring your own API keys. Agents run on your credentials; nothing is billed through us."
          />
          <ConnectorSettings initialData={connectorData} />
        </section>

        <section id="privacy-ai" aria-labelledby="privacy-ai-heading" className="ct-anchor-section">
          <SectionHeading
            id="privacy-ai"
            title="Privacy & AI"
            subtitle="Decide whether any AI may run outside this machine."
          />
          <PrivacyAiSection
            initialLocalOnly={agentDefaults.llmLocalOnly !== false}
            initialIntelligence={agentDefaults.intelligence ?? null}
            intelligenceOptions={intelligenceOptions}
            canManage={canManage}
          />
        </section>

        <section id="protection" aria-labelledby="protection-heading" className="ct-anchor-section">
          <SectionHeading
            id="protection"
            title="Ongoing protection"
            subtitle="Recurring broker re-checks for monitored cases, and optional scheduled web discovery."
          />
          <ProtectionSettings
            initialScheduledDiscovery={scheduledDiscovery.enabled}
            initialMonthlyQueryCap={scheduledDiscovery.cap}
            usedThisMonth={scheduledDiscovery.used}
            hasDiscoveryConnector={connectors.some(
              (c) => c.category === "discovery" && c.enabled && c.status === "connected",
            )}
            canManage={canManage}
          />
        </section>

        <section id="household" aria-labelledby="household-heading" className="ct-anchor-section">
          <SectionHeading
            id="household"
            title="Household"
            subtitle="People you are authorized to protect, such as a partner or child."
          />
          <FamilySettings initialMembers={familyMembers} initialSeatLimit={familySeatLimit} />
        </section>

        <section id="api" aria-labelledby="api-heading" className="ct-anchor-section">
          <SectionHeading
            id="api"
            title="API & integrations"
            subtitle="API keys, webhooks and hand-off kits for external AI agents."
          />
          <EnterpriseSettings initialKeys={apiKeys} initialWebhooks={webhooks} />
          <AgentBuilderKit />
          <AgentSetupGuide />
        </section>

        <section id="workspace" aria-labelledby="workspace-heading" className="ct-anchor-section">
          <SectionHeading
            id="workspace"
            title="Workspace"
            subtitle="How long case data is kept and how many API calls are allowed."
          />
          <WorkspaceSection
            initialRetentionDays={org?.retentionDays ?? 365}
            initialRateLimitPerHour={org?.rateLimitPerHour ?? 100}
            canManage={canManage}
          />
        </section>

        {showDeveloper && (
          <section id="developer" aria-labelledby="developer-heading" className="ct-anchor-section">
            <SectionHeading
              id="developer"
              title="Developer"
              subtitle="Tools for the people who run and maintain this ClearTrace instance."
            />
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <h3 className="font-medium text-white">
                  <Link href="/skills" className="text-teal-300 hover:text-teal-200">
                    Skill registry →
                  </Link>
                </h3>
                <p className="mt-1.5 text-sm text-slate-400">
                  The workflow steps Autopilot can run, with their risk levels and allowed tools.
                </p>
              </Card>
              <Card>
                <h3 className="font-medium text-white">
                  <Link href="/security" className="text-teal-300 hover:text-teal-200">
                    Sentinel release gate →
                  </Link>
                </h3>
                <p className="mt-1.5 text-sm text-slate-400">
                  Checks request-safety protections, dependencies and secret configuration
                  before a release.
                </p>
              </Card>
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}
