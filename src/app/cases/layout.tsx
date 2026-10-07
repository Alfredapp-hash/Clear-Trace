import type { ReactNode } from "react";
import { renderSessionShell } from "@/components/SessionShell";

/**
 * Shared chrome for /cases, /cases/new and /cases/[id]. The session is read once here, so the
 * navigation stays visible while a case loads (loading.tsx) or fails (error.tsx).
 */
export default async function CasesLayout({ children }: { children: ReactNode }) {
  return renderSessionShell(children);
}
