import {
  buildActionItems,
  computeDashboardStats,
  listDashboardCases,
  listRecentCaseActivity,
} from "./actions";
import { buildExposureRadar, computeVictoryStats } from "./radar";

/** Cases shown in the dashboard's "Recent cases" list. */
export const RECENT_CASE_LIMIT = 5;

/**
 * Everything the dashboard shows, from one load of the user's cases. Each helper receives the
 * loaded cases instead of querying them again; per-case counts come from grouped queries.
 */
export async function loadDashboard(userId: string, organizationId: string) {
  const cases = await listDashboardCases(userId, organizationId);
  const [actionItems, radar, recentActivity] = await Promise.all([
    buildActionItems(cases),
    buildExposureRadar(cases),
    listRecentCaseActivity(cases),
  ]);
  return {
    recentCases: cases.slice(0, RECENT_CASE_LIMIT),
    actionItems,
    stats: computeDashboardStats(cases),
    victories: computeVictoryStats(cases),
    radar,
    recentActivity,
  };
}

export type DashboardData = Awaited<ReturnType<typeof loadDashboard>>;
