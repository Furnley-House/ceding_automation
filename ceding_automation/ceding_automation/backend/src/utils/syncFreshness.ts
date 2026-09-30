// Debounce predicate for the interactive /cases/:id/sync-from-zoho
// endpoint. Applies the same 5-minute freshness pattern that
// requireCaseAccess.ts already uses for its per-request Zoho lookups —
// see FRESHNESS_WINDOW_MS at requireCaseAccess.ts:72. Kept as a separate
// constant so the two windows can diverge if a future workflow needs it.
//
// Context: CaseDetail.tsx fires this endpoint on every case-detail mount
// (a mutation, so react-query's staleTime doesn't cache it). Item 3 of
// the 2026-09-30 E2E findings — office triage sessions burn through the
// per-IP rate-limit budget on this alone. Debouncing here removes the
// bulk of the pressure without changing frontend behaviour.
//
// The manual "Sync from Zoho" button (CaseDetail.tsx:43-55) uses a
// DIFFERENT endpoint (importCrmTaskAsCase) and is deliberately not
// throttled — that's the escape hatch when a CA has just edited Zoho
// and needs an immediate refresh.

export const SYNC_FROM_ZOHO_WINDOW_MS = 5 * 60 * 1000;

export function isRecentSync(
  zohoSyncedAt: Date | null | undefined,
  now: Date,
  windowMs: number = SYNC_FROM_ZOHO_WINDOW_MS,
): boolean {
  if (!zohoSyncedAt) return false;
  return now.getTime() - zohoSyncedAt.getTime() < windowMs;
}
