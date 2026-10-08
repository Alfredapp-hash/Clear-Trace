import { redirectToSignIn } from "@/lib/auth/sign-in-redirect";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Badge, Button, Card, PageHeader } from "@/components/ui";
import {
  canAccessDeveloperTools,
  getSession,
  isDeveloperOperator,
} from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { securityScans } from "@/lib/db/schema";
import { runReleaseGate } from "@/lib/security/sentinel";

/** Server Action: re-checks the caller, runs the gate, then refreshes this page. */
async function runReleaseGateAction() {
  "use server";
  ensureDatabase();
  const session = await getSession();
  if (!session) redirectToSignIn("/security");
  // Running the gate needs an instance operator, not just an org owner (same rule as
  // POST /api/security/sentinel, plus DEVELOPER_MODE=1).
  if (!isDeveloperOperator(session)) {
    throw new Error("Sentinel access restricted to developer operators");
  }
  await runReleaseGate(session.userId);
  refresh();
}

/**
 * Sentinel (Settings → Developer). Server-gated: hidden (404) unless the user may see
 * developer tools; the last release-gate result for this user is read on the server.
 */
export default async function SecurityPage() {
  ensureDatabase();
  const session = await getSession();
  if (!session) redirectToSignIn("/security");
  if (!(await canAccessDeveloperTools(session))) notFound();

  const canRun = isDeveloperOperator(session);
  const latest = db
    .select()
    .from(securityScans)
    .where(and(eq(securityScans.scanType, "release_gate"), eq(securityScans.runBy, session.userId)))
    .orderBy(desc(securityScans.createdAt))
    .limit(1)
    .get();

  let findings: unknown = null;
  if (latest?.findingsJson) {
    try {
      findings = JSON.parse(latest.findingsJson) as unknown;
    } catch {
      findings = latest.findingsJson;
    }
  }

  return (
    <AppShell userName={session.name} orgName={session.organizationName}>
      <PageHeader
        eyebrow="Settings → Developer"
        title="Sentinel release gate"
        description="Checks request-safety protections, dependency hygiene and secret configuration before a release."
        action={
          <Link href="/settings#developer" className="text-sm font-medium text-teal-400 hover:text-teal-300">
            ← Back to settings
          </Link>
        }
      />

      <Card className="max-w-2xl">
        {canRun ? (
          <form action={runReleaseGateAction}>
            <Button type="submit">Run release gate</Button>
          </form>
        ) : (
          <p className="text-sm text-amber-200/90">
            Running the release gate is limited to instance operators: an account with the
            developer or admin role, or a server started with DEVELOPER_MODE=1.
          </p>
        )}

        {latest ? (
          <div className="mt-6 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={latest.status === "passed" ? "success" : "danger"}>
                {latest.status === "passed" ? "PASSED" : "FAILED"}
              </Badge>
              <span className="text-xs text-muted">
                Last run {new Date(latest.createdAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC
              </span>
            </div>
            <pre className="max-h-[32rem] overflow-auto rounded-xl bg-slate-900 p-4 text-xs text-slate-300">
              {JSON.stringify(findings, null, 2)}
            </pre>
          </div>
        ) : (
          <p className="mt-6 text-sm text-muted">No release gate has been run from this account yet.</p>
        )}
      </Card>
    </AppShell>
  );
}
