"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode } from "react";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/cases", label: "Cases" },
  { href: "/skills", label: "Skills" },
  { href: "/settings", label: "Settings" },
  { href: "/billing", label: "Billing" },
  { href: "/security", label: "Sentinel" },
];

export function AppShell({
  children,
  userName,
  orgName,
}: {
  children: ReactNode;
  userName: string;
  orgName: string;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const initials = userName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="ct-ambient min-h-screen text-slate-100">
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#08090d]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3.5">
          <div className="flex items-center gap-6 lg:gap-10">
            <Link href="/" className="group flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-teal-300 to-teal-600 text-xs font-bold text-slate-950 shadow-[0_0_28px_-6px_var(--accent-glow)] transition group-hover:shadow-[0_0_36px_-4px_var(--accent-glow)]">
                CT
              </span>
              <div className="hidden sm:block">
                <p className="text-sm font-semibold tracking-tight text-white">ClearTrace</p>
                <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
                  Privacy command
                </p>
              </div>
            </Link>
            <nav className="hidden gap-1 md:flex">
              {NAV.map((item) => {
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`relative rounded-xl px-3.5 py-2 text-sm font-medium transition duration-200 ${
                      active
                        ? "bg-white/[0.06] text-teal-200"
                        : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                    }`}
                  >
                    {active && (
                      <span className="absolute inset-x-3 -bottom-[13px] h-px bg-gradient-to-r from-transparent via-teal-400/80 to-transparent" />
                    )}
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 sm:flex">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-slate-600 to-slate-800 text-[10px] font-bold text-slate-200">
                {initials}
              </span>
              <div className="text-right">
                <p className="text-sm font-medium leading-tight text-white">{userName}</p>
                <p className="text-[10px] text-slate-500">{orgName}</p>
              </div>
            </div>
            <button
              onClick={logout}
              className="rounded-xl border border-white/10 px-3 py-2 text-xs font-medium text-slate-400 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-slate-200"
            >
              Sign out
            </button>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto border-t border-white/[0.04] px-4 py-2 md:hidden">
          {NAV.map((item) => {
            const active =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium ${
                  active ? "bg-teal-500/15 text-teal-300" : "text-slate-500"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8 lg:py-10">{children}</main>
    </div>
  );
}