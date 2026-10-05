import Link from "next/link";

export default function NotFound() {
  return (
    <main id="content" className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center px-4 py-16">
      <div className="ct-glass-strong rounded-2xl p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-300">Not found</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">
          We couldn&apos;t find that page
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-300">
          The link may be wrong, or the case may have been deleted or belong to another account.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/cases"
            className="rounded-xl bg-gradient-to-b from-teal-300 to-teal-500 px-4 py-2.5 text-sm font-medium text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300"
          >
            Go to cases
          </Link>
          <Link
            href="/"
            className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-slate-100 hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
