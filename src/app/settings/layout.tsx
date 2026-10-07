import type { ReactNode } from "react";
import { renderSessionShell } from "@/components/SessionShell";

/** Shared chrome for /settings: navigation stays visible while settings load or fail. */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  return renderSessionShell(children, "/settings");
}
