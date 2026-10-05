// backend/src/utils/dashboardStats.ts
//
// Pure helpers behind the dashboard's Caseflow chart and Team performance
// list. Kept free of Prisma so the bucketing and ranking rules are unit
// tested directly (dashboardStats.test.ts).

export interface CaseflowRow {
  createdAt: Date;
  completedAt: Date | null;
  /** true when the case counts as completed (CLOSED_STATUSES). */
  closed: boolean;
}

export interface CaseflowBucket {
  start: string;
  end: string;
  opened: number;
  completed: number;
}

/**
 * Count cases opened and completed in each [starts[i], starts[i+1]) bucket,
 * the last bucket ending at `end`. Starts come from the browser so period
 * boundaries follow the user's local calendar (weeks, days, months).
 */
export function bucketCaseflow(starts: Date[], end: Date, rows: CaseflowRow[]): CaseflowBucket[] {
  const edges = [...starts, end].map((d) => d.getTime());
  const buckets = starts.map((s, i) => ({
    start: s.toISOString(),
    end: new Date(edges[i + 1]).toISOString(),
    opened: 0,
    completed: 0,
  }));
  const indexOf = (t: number): number => {
    if (t < edges[0] || t >= edges[edges.length - 1]) return -1;
    let i = 0;
    while (t >= edges[i + 1]) i++;
    return i;
  };
  for (const r of rows) {
    const o = indexOf(r.createdAt.getTime());
    if (o >= 0) buckets[o].opened++;
    if (r.closed && r.completedAt) {
      const c = indexOf(r.completedAt.getTime());
      if (c >= 0) buckets[c].completed++;
    }
  }
  return buckets;
}

/** Validate the browser-supplied bucket boundaries; null when unusable. */
export function parseCaseflowRange(
  startsParam: unknown,
  endParam: unknown,
  maxBuckets = 40,
): { starts: Date[]; end: Date } | null {
  if (typeof startsParam !== "string" || typeof endParam !== "string") return null;
  const starts = startsParam.split(",").map((s) => new Date(s));
  const end = new Date(endParam);
  if (starts.length === 0 || starts.length > maxBuckets) return null;
  const all = [...starts, end];
  if (all.some((d) => Number.isNaN(d.getTime()))) return null;
  for (let i = 1; i < all.length; i++) {
    if (all[i].getTime() <= all[i - 1].getTime()) return null;
  }
  return { starts, end };
}

export interface OwnerCounts {
  userId: string;
  name: string;
  role: string;
  active: number;
  completed: number;
}

export interface TeamPerformanceRow extends OwnerCounts {
  rank: number;
  total: number;
  activePct: number;
  completedPct: number;
}

/**
 * Rank people by performance: completion rate (completed ÷ total) first,
 * then completed count, then total — so 9 of 10 done ranks above 1 of 1.
 * Cancelled cases are expected to be excluded by the caller.
 */
export function rankTeamPerformance(owners: OwnerCounts[]): TeamPerformanceRow[] {
  return owners
    .map((o) => {
      const total = o.active + o.completed;
      return {
        ...o,
        total,
        activePct: total ? Math.round((o.active / total) * 100) : 0,
        completedPct: total ? Math.round((o.completed / total) * 100) : 0,
        rate: total ? o.completed / total : 0,
      };
    })
    .filter((o) => o.total > 0)
    .sort((a, b) => b.rate - a.rate || b.completed - a.completed || b.total - a.total || a.name.localeCompare(b.name))
    .map(({ rate: _rate, ...o }, i) => ({ ...o, rank: i + 1 }));
}
