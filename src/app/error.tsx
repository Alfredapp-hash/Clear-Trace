"use client"; // Error boundaries must be Client Components

import Link from "next/link";
import { useEffect } from "react";

/**
 * Route-level error boundary. Server errors arrive with a generic message in
 * production; the digest matches the server log entry, so we show it for
 * support without leaking details.
 */
export default function ErrorPage({
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
    <main id="content" className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center px-4 py-16">
      <div role="alert" className="ct-glass-strong rounded-2xl p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-rose-300">
          Something went wrong
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">
          This page couldn&apos;t load
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-300">
          Nothing was sent or changed because of this error. Try again, or go back to your cases.
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
    </main>
  );
}
