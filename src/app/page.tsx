import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import {
  Alert,
  Badge,
  ButtonLink,
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
import { after } from "next/server";
import { and, eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { privacyCases, auditEvents } from "@/lib/db/schema";
import { getActionItems, getDashboardStats, type ActionItem } from "@/lib/dashboard/actions";
import { getConnectorHealth } from "@/lib/connectors/service";
import { getExposureRadar, getVictoryStats } from "@/lib/dashboard/radar";
import { maybeRunBackgroundJobs, shouldRunInlineWorker } from "@/lib/worker/processor";
import { log } from "@/lib/log";

const ACTION_LABEL: Record<ActionItem["type"], string> = {
  verification_due: "Check if it's gone",
  follow_up: "Follow-up due",
  reopened: "Reappeared",
  candidate_review: "Review matches",
  opt_out_pending: "Opt-out to submit",
  opt_out_verify: "Confirm opt-out",
  deindex_pending: "Search removal to submit",
};

/** Audit event types are snake_case identifiers; show them as a short sentence. */
function eventLabel(eventType: string): string {
  const words = eventType.split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export default async function DashboardPage() {
  ensureDatabase();
  const session = await getSession();
  if (!session) redirect("/login");

  // Background jobs never run on the render path. The worker-cron sidecar calls
  // /api/worker/run; only without one (no WORKER_SECRET, or INLINE_WORKER=1) do we fall
  // back to a throttled run after the response has been sent.
  if (shouldRunInlineWorker()) {
    after(async () => {
      try {
        await maybeRunBackgroundJobs();
      } catch (err) {
        log.error("worker.inline_run_failed", {
          job: "background_jobs",
          errorCode: err instanceof Error && /^[A-Z0-9_:]{2,64}$/.test(err.message) ? err.message : "WORKER_FAILED",
        });
      }
    });
  }

  const [cases, recentEvents, actionItems, stats, connectorHealth, radar, victories] =
    await Promise.all([
      db.query.privacyCases.findMany({
        where: and(
          eq(privacyCases.ownerUserId, session.userId),
          eq(privacyCases.organizationId, session.organizationId),
        ),
        orderBy: [desc(privacyCases.updatedAt)],
        limit: 5,
      }),
      db.query.auditEvents.findMany({
        where: eq(auditEvents.organizationId, session.organizationId),
        orderBy: [desc(auditEvents.createdAt)],
        limit: 8,
      }),
      getActionItems(session.userId, session.organizationId),
      getDashboardStats(session.userId, session.organizationId),
      getConnectorHealth(session.organizationId),
      getExposureRadar(session.userId, session.organizationId),
      getVictoryStats(session.userId, session.organizationId),
    ]);

  return (
    <AppShell userName={session.name} orgName={session.organizationName}>
      <PageHeader
        eyebrow="Command center"
        title="Dashboard"
        description="Exposure radar, case momentum, and audit activity — all in one view."
        action={
          <ButtonLink href="/cases/new" size="lg">New case</ButtonLink>
        }
      />

      {stats.total === 0 && (
        <div className="mb-8">
          <EmptyState
            title="Welcome to ClearTrace"
            description="Start with intake and consent, then run demo discovery — no API keys required. Configure connectors in Settings when you are ready for live search or Gmail draft push."
            action={
              <div className="flex flex-wrap justify-center gap-3">
                <ButtonLink href="/cases/new" size="lg">Start intake wizard</ButtonLink>
                <ButtonLink href="/settings" variant="secondary" size="lg">Configure connectors</ButtonLink>
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
              <ButtonLink href="/settings" variant="secondary">Open Settings</ButtonLink>
            }
          >
            Add SerpAPI or Google CSE for live discovery; Gmail for draft push; a local Ollama
            model for private draft polish (Local-only AI keeps personal data on this machine). Demo discovery works without keys. SMTP/Resend/webhook
            connectors can test or optionally send (Resend/SendGrid/Postmark) when enabled in Agent defaults.
          </Alert>
        </div>
      )}

      <Card variant="accent" className="mb-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-200">Progress report</p>
            <p className="mt-1 text-xs text-slate-500">
              Org-wide privacy snapshot — cases, exposures, SLAs, recent activity
            </p>
          </div>
          <a
            href="/api/reports/progress?format=markdown"
            className="rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-2 text-sm font-medium text-teal-300 transition hover:bg-teal-500/20"
          >
            Download report →
          </a>
        </div>
      </Card>

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
                    {ACTION_LABEL[item.type] ?? eventLabel(item.type)}
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
                      <Badge tone="info">{eventLabel(event.eventType)}</Badge>
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