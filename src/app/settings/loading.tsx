/**
 * Instant loading state for /settings while the server reads connectors and org settings.
 * Rendered without AppShell (which needs the session), so it is a plain skeleton.
 */
export default function SettingsLoading() {
  return (
    <div className="ct-ambient min-h-screen text-slate-100">
      <div
        role="status"
        aria-live="polite"
        className="mx-auto max-w-7xl px-6 py-8 lg:py-10"
      >
        <span className="sr-only">Loading settings…</span>
        <div aria-hidden="true" className="animate-pulse space-y-8">
          <div className="space-y-3">
            <div className="h-3 w-24 rounded bg-white/[0.08]" />
            <div className="h-9 w-48 rounded-lg bg-white/[0.08]" />
            <div className="h-4 w-full max-w-xl rounded bg-white/[0.05]" />
          </div>
          <div className="flex gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-8 w-32 rounded-lg bg-white/[0.05]" />
            ))}
          </div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-40 rounded-2xl border border-white/[0.06] bg-white/[0.03]" />
          ))}
        </div>
      </div>
    </div>
  );
}
