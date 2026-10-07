import Link from "next/link";
import { type ReactNode } from "react";
import { CURATED_BROKER_COUNT } from "@/lib/brokers/count";

/** Count kept in sync with the broker universe by count.test.ts (the catalog stays server-side). */
const AUTH_BULLETS = [
  `Removal playbooks for ${CURATED_BROKER_COUNT} data brokers, plus the CA, OR and TX registries`,
  "Private by default — AI runs on your device",
  "Removal certificates backed by a hash-linked activity log",
];

export function AuthLayout({
  children,
  title,
  subtitle,
  footer,
}: {
  children: ReactNode;
  title: string;
  subtitle: string;
  footer?: ReactNode;
}) {
  return (
    <div className="ct-ambient flex min-h-screen">
      <aside className="relative hidden w-[44%] overflow-hidden border-r border-white/[0.06] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="absolute inset-0 bg-gradient-to-br from-teal-500/10 via-transparent to-indigo-500/5" />
        <div className="relative">
          <Link href="/" className="inline-flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-300 to-teal-600 text-sm font-bold text-slate-950 shadow-[0_0_40px_-8px_var(--accent-glow)]">
              CT
            </span>
            <div>
              <p className="text-lg font-semibold tracking-tight text-white">ClearTrace</p>
              <p className="text-xs text-slate-400">Privacy remediation command</p>
            </div>
          </Link>
        </div>
        <div className="relative max-w-md">
          <p className="text-3xl font-semibold leading-tight tracking-tight text-white">
            Find exposure. Route removal. Prove it&apos;s gone.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-slate-300">
            Owner-controlled workflows with encrypted identity claims, policy-gated
            agents, and an auditable evidence chain. Your keys. Your approvals.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-slate-300">
            {AUTH_BULLETS.map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span aria-hidden="true" className="h-1 w-1 rounded-full bg-teal-400" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-muted">
          Authorized use only. All activity is logged.
        </p>
      </aside>

      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="ct-animate-in w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-teal-400">
              ClearTrace
            </p>
          </div>
          <div className="ct-glass-strong ct-shine rounded-2xl p-8">
            <div className="mb-8">
              <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
              <p className="mt-2 text-sm text-slate-300">{subtitle}</p>
            </div>
            {children}
            {footer && <div className="mt-6">{footer}</div>}
          </div>
        </div>
      </main>
    </div>
  );
}