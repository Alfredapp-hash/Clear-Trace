import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getCaseForUser } from "@/lib/cases/service";

/**
 * Ownership gate for /cases/[id], deliberately ABOVE the segment's loading.tsx: once a
 * loading fallback streams, the response status is already 200, so a notFound() from the page
 * would no longer produce a 404. Checking here keeps "someone else's case" a real 404 while
 * the page's data still loads behind the skeleton.
 */
export default async function CaseLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/api/auth/session-expired");
  const { id } = await params;
  if (!(await getCaseForUser(id, session))) notFound();
  return children;
}
