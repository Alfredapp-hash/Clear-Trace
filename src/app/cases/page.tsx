import { AppShell } from "@/components/AppShell";
import {
  ButtonLink,
  EmptyState,
  ListRow,
  PageHeader,
  StatusBadge,
} from "@/components/ui";
import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { listCasesForUser } from "@/lib/cases/service";
import { plainStatus } from "@/lib/ux/plain-status";
import { redirect } from "next/navigation";

export default async function CasesPage() {
  ensureDatabase();
  const session = await getSession();
  if (!session) redirect("/login");

  const cases = await listCasesForUser(session);

  return (
    <AppShell userName={session.name} orgName={session.organizationName}>
      <PageHeader
        eyebrow="Workflows"
        title="Privacy cases"
        description="Authorized remediation workflows with evidence, drafts, and verification."
        action={
          <ButtonLink href="/cases/new" size="lg">New case</ButtonLink>
        }
      />

      {cases.length === 0 ? (
        <EmptyState
          title="No cases yet"
          description="Create your first privacy case to begin intake, discovery, and removal workflows."
          action={
            <ButtonLink href="/cases/new" size="lg">Create first case</ButtonLink>
          }
        />
      ) : (
        <ul className="space-y-3">
          {cases.map((c) => (
            <li key={c.id}>
              <ListRow href={`/cases/${c.id}`} className="!items-start !py-4">
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-medium tracking-tight text-white">{c.title}</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {c.caseType.replaceAll("_", " ")} · Created{" "}
                    {new Date(c.createdAt).toLocaleDateString()}
                  </p>
                  <p className="mt-2 text-xs text-slate-600">{plainStatus(c.status)}</p>
                </div>
                <StatusBadge status={c.status} />
              </ListRow>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}