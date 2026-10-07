"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode } from "react";

/**
 * Primary navigation. Developer tools (Skills registry, Sentinel) are not here: they live
 * under Settings → Developer and are shown only to developer operators.
 */
const NAV: { href: Route; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/cases", label: "Cases" },
  { href: "/settings", label: "Settings" },
  { href: "/billing", label: "Billing" },
];

function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  // Developer pages are reached from Settings, so keep Settings highlighted there.
  if (href === "/settings" && (pathname.startsWith("/skills") || pathname.startsWith("/security"))) {
    return true;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  children,
  userName,
  orgName,
}: {
  children: ReactNode;
  userName: string;
  orgName: string;
}) {
  const pathname = usePathname() ?? "";
  const displayName = userName.trim();
  const displayOrg = orgName.trim();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    // Full navigation, not router.push: drops the client router cache (signed-in RSC payloads
    // must not survive Back) and stops in-flight prefetches of now-protected pages.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard reload on sign-out
    window.location.assign("/login");
  }

  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="ct-ambient min-h-screen text-slate-100">
      <a href="#content" className="ct-skip-link">
        Skip to content
      </a>
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#08090d]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3.5">
          <div className="flex items-center gap-6 lg:gap-10">
            <Link href="/" className="group flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-teal-300 to-teal-600 text-xs font-bold text-slate-950 shadow-[0_0_28px_-6px_var(--accent-glow)] transition group-hover:shadow-[0_0_36px_-4px_var(--accent-glow)]">
                CT
              </span>
              <div className="hidden sm:block">
                <p className="text-sm font-semibold tracking-tight text-white">ClearTrace</p>
                <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
                  Privacy command
                </p>
              </div>
            </Link>
            <nav aria-label="Primary" className="hidden gap-1 md:flex">
              {NAV.map((item) => {
                const active = isActive(item.href, pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
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
            {(displayName || displayOrg) && (
              <div className="hidden items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 sm:flex">
                {initials && (
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-slate-600 to-slate-800 text-[10px] font-bold text-slate-200"
                  >
                    {initials}
                  </span>
                )}
                <div className="text-right">
                  {displayName && (
                    <p
                      data-testid="shell-user-name"
                      className="text-sm font-medium leading-tight text-white"
                    >
                      {displayName}
                    </p>
                  )}
                  {displayOrg && (
                    <p data-testid="shell-org-name" className="text-[10px] text-muted">
                      {displayOrg}
                    </p>
                  )}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={logout}
              className="rounded-xl border border-white/10 px-3 py-2 text-xs font-medium text-slate-400 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-slate-200"
            >
              Sign out
            </button>
          </div>
        </div>
        <nav
          aria-label="Primary"
          className="flex gap-1 overflow-x-auto border-t border-white/[0.04] px-4 py-2 md:hidden"
        >
          {NAV.map((item) => {
            const active = isActive(item.href, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium ${
                  active ? "bg-teal-500/15 text-teal-300" : "text-muted"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main id="content" tabIndex={-1} className="mx-auto max-w-7xl px-6 py-8 focus:outline-none lg:py-10">
        {children}
      </main>
    </div>
  );
}