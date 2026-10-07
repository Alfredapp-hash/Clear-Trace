import { SettingsSkeleton } from "@/components/Skeletons";

/**
 * Instant loading state for /settings while the server reads connectors and org settings.
 * Rendered inside the app shell (settings/layout.tsx), so navigation stays visible.
 */
export default function SettingsLoading() {
  return <SettingsSkeleton />;
}
