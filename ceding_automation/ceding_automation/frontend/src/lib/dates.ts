// frontend/src/lib/dates.ts
// Date helpers that produce the UK calendar date rather than the UTC one.
//
// Why this exists: the previous `new Date().toISOString().slice(0, 10)`
// pattern (3 call sites: CaseDetail.tsx, SendLOAWorkspace.tsx,
// AssignParaplannerDialog.tsx) returned the UTC date, so a case marked
// complete at 00:30 BST (= 23:30 UTC the previous day) persisted as the
// previous calendar date. Reported by Revathy 2026-10-03 (item 9) on
// overnight completions.
//
// Furnley House operates in the UK, so Europe/London is the canonical
// clock. We don't use the browser's locale default (toLocaleDateString
// with no timeZone) because a CA working from a device set to another
// timezone would still want UK dates on UK cases.

/** Today's calendar date in Europe/London, as YYYY-MM-DD. */
export function todayUkDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

/** `todayUkDate() + N days`, as YYYY-MM-DD. Used for due-date defaults
 *  (e.g. "default due in 3 days"). Day arithmetic is on the calendar date
 *  itself, so there's no DST edge — we're not adding 72 hours, we're
 *  adding 3 days to the YYYY-MM-DD string. */
export function ukDatePlusDays(days: number, now: Date = new Date()): string {
  const today = todayUkDate(now);
  const [y, m, d] = today.split("-").map(Number);
  // UTC base to avoid any local-timezone surprises in the arithmetic
  // step. The result is converted back to its own YYYY-MM-DD using the
  // UTC components, so it stays as a calendar date rather than a point
  // in time.
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(base.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
