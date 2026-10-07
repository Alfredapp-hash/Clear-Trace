"use client"; // Error boundaries must be Client Components

import { ErrorPanel } from "@/components/RouteError";

/**
 * Root route-level error boundary (outside the app shell — e.g. login / register / billing).
 * Segments with the shell (/cases, /settings) have their own error.tsx inside the shell.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main id="content" className="flex min-h-[60vh] flex-col justify-center px-4 py-16">
      <ErrorPanel error={error} retry={retry} />
    </main>
  );
}
