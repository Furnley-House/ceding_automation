import { useQuery } from "@tanstack/react-query";
import { caseStatsWindow, getCaseStats, type CaseStats } from "@/services/api";

/**
 * Dashboard KPIs (GET /cases/stats). The single entry point for the header's
 * "This week" counter and the dashboard tiles, so both always read the same
 * cache entry. The week/month window is in the key: when the calendar rolls
 * over, the key changes and the numbers refetch together.
 */
export function useCaseStats() {
  const win = caseStatsWindow();
  return useQuery<CaseStats>({
    queryKey: ["cases", "stats", win.weekStart, win.monthStart],
    queryFn: () => getCaseStats(win),
    refetchInterval: 5 * 60_000,
  });
}
