"use client"; // Error boundaries must be Client Components

import { ErrorPanel } from "@/components/RouteError";

/** Renders inside the segment layout, so the app navigation stays available. */
export default function SegmentError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="py-8">
      <ErrorPanel error={error} retry={retry} />
    </div>
  );
}
