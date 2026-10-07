/**
 * Loading placeholders rendered inside the app shell (segment loading.tsx files and the
 * dashboard's Suspense fallback). Each announces a short status message to screen readers;
 * the shapes themselves are hidden from assistive technology.
 */

function Bar({ className }: { className: string }) {
  return <div className={`rounded bg-white/[0.08] ${className}`} />;
}

function Block({ className }: { className: string }) {
  return <div className={`rounded-2xl border border-white/[0.06] bg-white/[0.03] ${className}`} />;
}

function SkeletonFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" data-testid="page-skeleton">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="animate-pulse space-y-8 motion-reduce:animate-none">
        {children}
      </div>
    </div>
  );
}

function HeaderSkeleton() {
  return (
    <div className="space-y-3">
      <Bar className="h-3 w-24" />
      <Bar className="h-9 w-56 rounded-lg" />
      <div className="h-4 w-full max-w-xl rounded bg-white/[0.05]" />
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <SkeletonFrame label="Loading your dashboard…">
      <HeaderSkeleton />
      <Block className="h-48" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Block key={i} className="h-24" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Block className="h-64" />
        <Block className="h-64" />
      </div>
    </SkeletonFrame>
  );
}

export function CaseListSkeleton() {
  return (
    <SkeletonFrame label="Loading your cases…">
      <HeaderSkeleton />
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <Block key={i} className="h-24" />
        ))}
      </div>
    </SkeletonFrame>
  );
}

export function CaseDetailSkeleton() {
  return (
    <SkeletonFrame label="Loading case…">
      <Bar className="h-4 w-24" />
      <div className="space-y-3 border-b border-white/[0.06] pb-8">
        <Bar className="h-9 w-72 rounded-lg" />
        <div className="h-4 w-full max-w-lg rounded bg-white/[0.05]" />
      </div>
      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Block className="h-40" />
          <Block className="h-72" />
        </div>
        <div className="space-y-6">
          <Block className="h-48" />
          <Block className="h-32" />
        </div>
      </div>
    </SkeletonFrame>
  );
}

export function SettingsSkeleton() {
  return (
    <SkeletonFrame label="Loading settings…">
      <HeaderSkeleton />
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-8 w-32 rounded-lg bg-white/[0.05]" />
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <Block key={i} className="h-40" />
      ))}
    </SkeletonFrame>
  );
}

export function IntakeSkeleton() {
  return (
    <SkeletonFrame label="Loading new case form…">
      <div className="mx-auto max-w-3xl space-y-6">
        <HeaderSkeleton />
        <div className="h-1 rounded-full bg-white/[0.06]" />
        <Block className="h-96" />
      </div>
    </SkeletonFrame>
  );
}
