// backend/src/utils/checklistReadiness.ts
//
// Predicate: "is this case's checklist ready for a bulk N/A mark?"
//
// Marking every missing field N/A only makes sense once a case has a
// committed plan type AND its checklist_fields table has been seeded
// (i.e. row-per-template row exists). Before that, the caller would
// either be creating rows fresh AS N/A on a stage-1..3 case with no
// committed planType, or clobbering a stage that hasn't been through
// the seed step. Both are wrong shapes.
//
// H23 (Nishant's seed-at-submit design) originally guarded this with
// `Case.extractionSubmittedAt IS NOT NULL` as a proxy for "seeded". But
// that column postdates the H23 deploy — 205 of 216 prod cases
// (2026-09-08 count) have it null, including cases with 71 seeded
// fields and a fully-extracted document. Using the column as a gate
// broke Mark-as-N/A on the whole pre-H23 backlog. This helper checks
// the underlying invariant directly — real planType + at least one
// checklist_fields row — so the timestamp becomes advisory, not
// gating.
//
// Kept as a pure helper so the route handler stays a thin wrapper and
// the predicate can be unit-tested without a Prisma round-trip.

export interface ChecklistReadinessInput {
  /** Committed plan type on the Case row. Null / empty on stages 1-3. */
  planType: string | null | undefined;
  /** Count of checklist_fields rows for this case. Zero means the
   *  seed step hasn't run for this case yet. */
  checklistFieldCount: number;
}

/**
 * True iff the case is seeded enough for a bulk-mark-N/A to be
 * meaningful. Both conditions must hold — a case with a planType but
 * zero fields is a race we shouldn't resolve by creating rows, and a
 * case with fields but a null planType is a corrupted shape we
 * shouldn't accept either.
 */
export function canMarkMissingAsNA(input: ChecklistReadinessInput): boolean {
  if (input.planType == null) return false;
  if (typeof input.planType === "string" && input.planType.trim() === "") return false;
  return input.checklistFieldCount > 0;
}
