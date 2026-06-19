import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ListRow,
  PageHeader,
  SectionTitle,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { redirect } from "next/navigation";
import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { privacyCases, auditEvents } from "@/lib/db/schema";
import { getActionItems, getDashboardStats } from "@/lib/dashboard/actions";
import { getConnectorHealth } from "@/lib/connectors/service";
import { getExposureRadar, getVictoryStats } from "@/lib/dashboard/radar";
import { maybeRunBackgroundJobs } from "@/lib/worker/processor";

export default async function DashboardPage() {
  ensureDatabase();
  const session = await getSession();
  if (!session) redirect("/login");

  await maybeRunBackgroundJobs();

  const [cases, recentEvents, actionItems, stats, connectorHealth, radar, victories] =
    await Promise.all([
      db.query.privacyCases.findMany({
        where: eq(privacyCases.ownerUserId, session.userId),
        orderBy: [desc(privacyCases.updatedAt)],
        limit: 5,
      }),
      db.query.auditEvents.findMany({
        where: eq(auditEvents.organizationId, session.organizationId),
        orderBy: [desc(auditEvents.createdAt)],
        limit: 8,
      }),
      getActionItems(session.userId),
      getDashboardStats(session.userId),
      getConnectorHealth(session.organizationId),
      getExposureRadar(session.userId),
      getVictoryStats(session.userId),
    ]);

  return (
    <AppShell userName={session.name} orgName={session.organizationName}>
      <PageHeader
        eyebrow="Command center"
        title="Dashboard"
        description="Exposure radar, case momentum, and audit activity — all in one view."
        action={
          <Link href="/cases/new">
            <Button size="lg">New case</Button>
          </Link>
        }
      />

      {stats.total === 0 && (
        <div className="mb-8">
          <EmptyState
            title="Welcome to ClearTrace"
            description="Start with intake and consent, then run demo discovery — no API keys required. Configure connectors in Settings when you are ready for live search or Gmail draft push."
            action={
              <div className="flex flex-wrap justify-center gap-3">
                <Link href="/cases/new">
                  <Button size="lg">Start intake wizard</Button>
                </Link>
                <Link href="/settings">
                  <Button variant="secondary" size="lg">
                    Configure connectors
                  </Button>
                </Link>
              </div>
            }
          />
        </div>
      )}

      {!connectorHealth.discoveryReady && stats.total > 0 && (
        <div className="mb-8">
          <Alert
            tone="warning"
            title="Configure connectors to unlock agents"
            action={
              <Link href="/settings">
                <Button variant="secondary">Open Settings</Button>
              </Link>
            }
          >
            Add SerpAPI, Bing, or Google CSE for live discovery; Gmail for draft push; LLM keys
            for optional draft polish. Demo discovery works without keys. SMTP/Resend/webhook
            connectors can test or optionally send (Resend/SendGrid/Postmark) when enabled in Agent defaults.
          </Alert>
        </div>
      )}

      <div className="ct-stagger mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total cases" value={stats.total} />
        <StatCard label="Active" value={stats.active} accent />
        <StatCard label="Removed" value={stats.removed} />
        <StatCard
          label="Win rate"
          value={`${Math.round(victories.winRate * 100)}%`}
          hint="Cases verified removed"
        />
        <StatCard
          label="Action items"
          value={actionItems.length}
          accent={actionItems.length > 0}
        />
      </div>

      {radar.filter((r) => r.surfaceCount > 0).length > 0 && (
        <Card variant="elevated" className="mb-8">
          <SectionTitle subtitle="Live surface map across your cases">Exposure radar</SectionTitle>
          <ul className="space-y-2">
            {radar
              .filter((r) => r.surfaceCount > 0)
              .slice(0, 5)
              .map((r) => (
                <li key={r.caseId}>
                  <ListRow href={`/cases/${r.caseId}`}>
                    <div>
                      <p className="font-medium text-white">{r.caseTitle}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {r.surfaceCount} surface{r.surfaceCount !== 1 ? "s" : ""}
                        {r.highImpact > 0 && (
                          <span className="text-rose-400">
                            {" "}
                            · {r.highImpact} high-impact
                          </span>
                        )}
                      </p>
                    </div>
                    <StatusBadge status={r.caseStatus} />
                  </ListRow>
                </li>
              ))}
          </ul>
        </Card>
      )}

      {actionItems.length > 0 && (
        <Card variant="warning" className="mb-8">
          <SectionTitle subtitle="Needs your attention">Action required</SectionTitle>
          <ul className="space-y-2">
            {actionItems.map((item) => (
              <li key={`${item.caseId}-${item.type}`}>
                <ListRow href={`/cases/${item.caseId}`}>
                  <div>
                    <p className="font-medium text-white">{item.caseTitle}</p>
                    <p className="mt-0.5 text-sm text-slate-400">{item.message}</p>
                  </div>
                  <Badge tone={item.priority === "high" ? "danger" : "warning"}>
                    {item.type.replaceAll("_", " ")}
                  </Badge>
                </ListRow>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card variant="elevated">
          <SectionTitle
            action={
              <Link
                href="/cases/new"
                className="text-sm font-medium text-teal-400 hover:text-teal-300"
              >
                New case →
              </Link>
            }
          >
            Recent cases
          </SectionTitle>
          {cases.length === 0 ? (
            <p className="text-sm text-slate-500">
              No cases yet.{" "}
              <Link href="/cases/new" className="text-teal-400 hover:text-teal-300">
                Create your first privacy case
              </Link>
            </p>
          ) : (
            <ul className="space-y-2">
              {cases.map((c) => (
                <li key={c.id}>
                  <ListRow href={`/cases/${c.id}`}>
                    <div>
                      <p className="font-medium text-white">{c.title}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Updated {new Date(c.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <StatusBadge status={c.status} />
                  </ListRow>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card variant="elevated">
          <SectionTitle subtitle="Hash-chained audit trail">Recent activity</SectionTitle>
          {recentEvents.length === 0 ? (
            <p className="text-sm text-slate-500">No activity yet.</p>
          ) : (
            <ul className="space-y-2">
              {recentEvents.map((event) => (
                <li key={event.id}>
                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3.5">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <Badge tone="info">{event.eventType.replaceAll("_", " ")}</Badge>
                      <span className="text-xs text-slate-500">
                        {new Date(event.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-sm text-slate-300">{event.summary}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}