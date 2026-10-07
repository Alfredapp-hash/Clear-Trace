import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { renderSessionShell } from "@/components/SessionShell";
import { ContentErrorBoundary } from "@/components/RouteError";
import { DashboardSkeleton } from "@/components/Skeletons";
import {
  Alert,
  Badge,
  ButtonLink,
  Card,
  ListRow,
  PageHeader,
  SectionTitle,
  StatCard,
  StatusBadge,
} from "@/components/ui";
import { getSession } from "@/lib/auth/session";
import type { ActionItem } from "@/lib/dashboard/actions";
import { loadDashboard } from "@/lib/dashboard/load";
import { getConnectorHealth } from "@/lib/connectors/service";
import { formatDate, formatDateTime } from "@/lib/ux/plain-status";
import {
  maybeRunBackgroundJobs,
  shouldRunInlineWorker,
} from "@/lib/worker/processor";
import { log } from "@/lib/log";

const ACTION_LABEL: Record<ActionItem["type"], string> = {
  verification_due: "Check if it's gone",
  follow_up: "Follow-up",
  reopened: "Listing is back",
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

const ONBOARDING_STEPS = [
  {
    title: "Tell ClearTrace who to look for",
    body: "Start a case with your name and, if you like, places you've lived. These details are encrypted when saved.",
  },
  {
    title: "Review what it finds",
    body: "Confirm which listings are really you and reject the ones that aren't. Nothing is sent at this stage.",
  },
  {
    title: "Ask sites to remove them",
    body: "ClearTrace prepares removal requests. You review and send each one, then check back to see whether the listing is gone.",
  },
] as const;

export default async function DashboardPage() {
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
          errorCode:
            err instanceof Error && /^[A-Z0-9_:]{2,64}$/.test(err.message)
              ? err.message
              : "WORKER_FAILED",
        });
      }
    });
  }

  // The shell (navigation) renders as soon as the session is read; the dashboard data streams
  // in behind a skeleton, and a failure there keeps the navigation on screen.
  return renderSessionShell(
    <ContentErrorBoundary>
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent />
      </Suspense>
    </ContentErrorBoundary>,
  );
}

async function DashboardContent() {
  const session = await getSession();
  if (!session) redirect("/login");

  const [data, connectorHealth] = await Promise.all([
    loadDashboard(session.userId, session.organizationId),
    getConnectorHealth(session.organizationId),
  ]);
  const { recentCases, actionItems, stats, radar, recentActivity } = data;
  const radarWithListings = radar.filter((r) => r.surfaceCount > 0).slice(0, 5);

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        description="What needs your attention across your privacy cases."
        action={
          <ButtonLink href="/cases/new" size="lg">
            New case
          </ButtonLink>
        }
      />

      {stats.total === 0 && (
        <section data-testid="dashboard-onboarding" className="mb-8">
          <Card variant="elevated">
            <SectionTitle subtitle="Three steps to get started">
              Welcome to ClearTrace
            </SectionTitle>
            <ol className="grid gap-4 md:grid-cols-3">
              {ONBOARDING_STEPS.map((s, i) => (
                <li
                  key={s.title}
                  className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-300">
                    Step {i + 1}
                  </p>
                  <p className="mt-1.5 font-medium text-white">{s.title}</p>
                  <p className="mt-1 text-sm text-[var(--muted)]">{s.body}</p>
                </li>
              ))}
            </ol>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <ButtonLink href="/cases/new" size="lg">
                Start your first case
              </ButtonLink>
              <p className="text-sm text-[var(--muted)]">
                Until you connect a search account, searches use sample results.{" "}
                <Link
                  href="/settings"
                  className="text-teal-300 underline-offset-2 hover:underline"
                >
                  Set up search in Settings
                </Link>
              </p>
            </div>
          </Card>
        </section>
      )}

      {stats.total > 0 && (
        <section data-testid="dashboard-action-items" className="mb-8">
          <Card variant={actionItems.length > 0 ? "warning" : "elevated"}>
            <SectionTitle
              subtitle={
                actionItems.length > 0
                  ? `${actionItems.length} ${actionItems.length === 1 ? "thing needs" : "things need"} your attention`
                  : undefined
              }
            >
              Needs your attention
            </SectionTitle>
            {actionItems.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">
                Nothing needs you right now. Scheduled checks will show up here
                when they are due.
              </p>
            ) : (
              <ul className="space-y-2">
                {actionItems.map((item) => (
                  <li key={`${item.caseId}-${item.type}`}>
                    <ListRow href={`/cases/${item.caseId}`}>
                      <div>
                        <p className="font-medium text-white">
                          {item.caseTitle}
                        </p>
                        <p className="mt-0.5 text-sm text-slate-300">
                          {item.message}
                        </p>
                      </div>
                      <Badge
                        tone={item.priority === "high" ? "danger" : "warning"}
                      >
                        {ACTION_LABEL[item.type] ?? eventLabel(item.type)}
                      </Badge>
                    </ListRow>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      )}

      {!connectorHealth.discoveryReady && stats.total > 0 && (
        <div className="mb-8">
          <Alert
            tone="info"
            title="Searches are using sample results"
            action={
              <ButtonLink href="/settings" variant="secondary">
                Set up search
              </ButtonLink>
            }
          >
            Connect a search account in Settings to look for real listings.
            Email and other options are there too, and none of them are required
            to try ClearTrace.
          </Alert>
        </div>
      )}

      {stats.total > 0 && (
        <div className="ct-stagger mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Cases" value={stats.total} />
          <StatCard label="In progress" value={stats.active} accent />
          <StatCard label="Confirmed removed" value={stats.removed} />
          <StatCard
            label="Need attention"
            value={actionItems.length}
            accent={actionItems.length > 0}
          />
        </div>
      )}

      {radarWithListings.length > 0 && (
        <Card variant="elevated" className="mb-8">
          <SectionTitle subtitle="Listings found or still being reviewed, by case">
            Where your information appears
          </SectionTitle>
          <ul className="space-y-2">
            {radarWithListings.map((r) => (
              <li key={r.caseId}>
                <ListRow href={`/cases/${r.caseId}`}>
                  <div>
                    <p className="font-medium text-white">{r.caseTitle}</p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {r.surfaceCount} listing{r.surfaceCount !== 1 ? "s" : ""}
                      {r.highImpact > 0 && (
                        <span className="text-rose-300">
                          {" "}
                          · {r.highImpact} with sensitive details
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

      {stats.total > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card variant="elevated">
            <SectionTitle
              action={
                <Link
                  href="/cases"
                  className="text-sm font-medium text-teal-400 hover:text-teal-300"
                >
                  All cases →
                </Link>
              }
            >
              Recent cases
            </SectionTitle>
            <ul className="space-y-2">
              {recentCases.map((c) => (
                <li key={c.id}>
                  <ListRow href={`/cases/${c.id}`}>
                    <div>
                      <p className="font-medium text-white">{c.title}</p>
                      <p className="mt-0.5 text-xs text-[var(--muted)]">
                        Updated {formatDate(c.updatedAt)}
                      </p>
                    </div>
                    <StatusBadge status={c.status} />
                  </ListRow>
                </li>
              ))}
            </ul>
          </Card>

          <section data-testid="dashboard-recent-activity">
            <Card variant="elevated">
              <SectionTitle subtitle="Recent changes to your own cases">
                Recent activity
              </SectionTitle>
              {recentActivity.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">
                  No activity on your cases yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {recentActivity.map((event) => (
                    <li key={event.id}>
                      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3.5">
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <Badge tone="info">
                            {eventLabel(event.eventType)}
                          </Badge>
                          <span className="text-xs text-[var(--muted)]">
                            {formatDateTime(event.createdAt)}
                          </span>
                        </div>
                        <p className="text-sm text-slate-300">
                          {event.summary}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>
        </div>
      )}

      {stats.total > 0 && (
        <Card className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-200">
                Progress report
              </p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                A summary you can save: cases, listings, deadlines and recent
                activity.
              </p>
            </div>
            <a
              href="/api/reports/progress?format=markdown"
              className="rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-2 text-sm font-medium text-teal-300 transition hover:bg-teal-500/20"
            >
              Download report
            </a>
          </div>
        </Card>
      )}
    </>
  );
}
