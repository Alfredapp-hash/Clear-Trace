import { redirectToSignIn } from "@/lib/auth/sign-in-redirect";
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
import { caseTypeLabel, formatDate, plainStatus } from "@/lib/ux/plain-status";
import { Suspense } from "react";
import { CaseListSkeleton } from "@/components/Skeletons";

/**
 * The list streams in behind a skeleton inside the shell. This is a Suspense boundary in the
 * page rather than cases/loading.tsx on purpose: a segment loading.tsx would also wrap
 * /cases/[id] and start streaming (status 200) before its ownership check could return 404.
 */
export default function CasesPage() {
  return (
    <Suspense fallback={<CaseListSkeleton />}>
      <CaseList />
    </Suspense>
  );
}

async function CaseList() {
  ensureDatabase();
  const session = await getSession();
  if (!session) redirectToSignIn("/cases");

  const cases = await listCasesForUser(session);

  return (
    <>
      <PageHeader
        eyebrow="Workflows"
        title="Privacy cases"
        description="Each case looks for where your information appears, helps you ask sites to remove it, and re-checks whether it is still there."
        action={
          <ButtonLink href="/cases/new" size="lg">New case</ButtonLink>
        }
      />

      {cases.length === 0 ? (
        <EmptyState
          title="No cases yet"
          description="Create your first case to search for your information and start removing it."
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
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    {caseTypeLabel(c.caseType)} · Created {formatDate(c.createdAt)}
                  </p>
                  <p className="mt-2 text-xs text-[var(--muted)]">{plainStatus(c.status)}</p>
                </div>
                <StatusBadge status={c.status} />
              </ListRow>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}