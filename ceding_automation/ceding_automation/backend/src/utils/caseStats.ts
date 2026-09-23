import { CaseStatus } from "@prisma/client";

// Pure helpers behind GET /cases/stats — kept out of the route so the
// counting rules (what's active / done / in review) and the median maths
// can be unit-tested without a database.

// Only STAGE_10_COMPLETE is done. APPROVED means the checklist is signed off
// but Stage 9 (Export & WorkDrive) hasn't run yet, so it's still active.
export const CLOSED_STATUSES: CaseStatus[] = [CaseStatus.STAGE_10_COMPLETE];
export const REVIEW_STATUSES: CaseStatus[] = [CaseStatus.STAGE_9_ADVISER_REVIEW, CaseStatus.IN_REVIEW];

const DAY_MS = 86_400_000;

export function summariseStatusCounts(rows: { status: CaseStatus; count: number }[]) {
  const countOf = (statuses: CaseStatus[]) =>
    rows.filter((r) => statuses.includes(r.status)).reduce((sum, r) => sum + r.count, 0);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const completed = countOf(CLOSED_STATUSES);
  const cancelled = countOf([CaseStatus.CANCELLED]);
  return {
    total,
    // CANCELLED is neither active nor completed.
    active: total - completed - cancelled,
    completed,
    cancelled,
    inReview: countOf(REVIEW_STATUSES),
    onHold: countOf([CaseStatus.ON_HOLD]),
  };
}

// Median elapsed days from case creation to completion, 1 d.p. Rows with a
// completion before creation (bad legacy data) are ignored.
export function medianCycleDays(
  rows: { createdAt: Date; completedAt: Date | null }[],
): { medianDays: number | null; sampleSize: number } {
  const durations = rows
    .filter((r) => r.completedAt)
    .map((r) => (r.completedAt!.getTime() - r.createdAt.getTime()) / DAY_MS)
    .filter((d) => d >= 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return { medianDays: null, sampleSize: 0 };
  const mid = Math.floor(durations.length / 2);
  const m = durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
  return { medianDays: Math.round(m * 10) / 10, sampleSize: durations.length };
}
