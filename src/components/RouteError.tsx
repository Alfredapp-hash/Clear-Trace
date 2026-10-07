"use client";

import Link from "next/link";
import { catchError, type ErrorInfo } from "next/error";
import { useEffect } from "react";

/**
 * Error UI shared by the route error boundaries. Copy stays truthful: a failed page load
 * does not tell us whether an action the user had just started finished, so we say so and
 * point them at where they can check, instead of claiming nothing changed.
 *
 * Server errors arrive with a generic message in production; the digest matches the server
 * log entry, so it is shown for support without leaking details.
 */
export function ErrorPanel({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="ct-glass-strong mx-auto max-w-lg rounded-2xl p-6">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-rose-300">
        Something went wrong
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">
        This page couldn&apos;t load
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-slate-300">
        An error stopped this page from loading. If you had just started an action — such as
        sending a request or changing a case — it may or may not have finished. Check the case
        before trying it again so nothing is done twice.
      </p>
      {error.digest && (
        <p className="mt-3 text-xs text-[var(--muted)]">
          Error reference: <code className="font-mono text-slate-200">{error.digest}</code>
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="rounded-xl bg-gradient-to-b from-teal-300 to-teal-500 px-4 py-2.5 text-sm font-medium text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300"
        >
          Try again
        </button>
        <Link
          href="/cases"
          className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-100 hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300"
        >
          Go to cases
        </Link>
      </div>
    </div>
  );
}

/** Component-level boundary for content rendered inside the shell outside a segment (the dashboard). */
export const ContentErrorBoundary = catchError(function ContentErrorFallback(
  _props: { label?: string },
  { error, retry }: ErrorInfo,
) {
  const err = error instanceof Error ? error : new Error("Unknown error");
  return <ErrorPanel error={err} retry={retry} />;
});
