// frontend/src/lib/contributionsDerivation.ts
//
// Pure client-side derivations for the two-grid contributions UI
// (H33-followup PR3). Kept separate from the React component so the
// branching logic — especially the conflict-marker rule — can be
// unit-tested without a jsdom render.
//
// PR2's backend returns each parent contribution row with its
// non-superseded transaction children (`include: { transactions:
// { where: { supersededAt: null } } }`). The client sums those for
// the displayed cell total and derives the amber conflict marker
// entirely from what's in memory. No server flag, no round trip.

import type {
  ContributionRow,
  ContributionTransaction,
} from "@/hooks/useContributions";

export type ContributionType = "EMPLOYER" | "PERSONAL";

/**
 * Sum a cell's non-superseded transactions of the given type.
 * Backend already filters supersededAt at the query level so the
 * `.filter` here defends against future include-superseded changes
 * (e.g. a PR3 drill-down variant that fetches both).
 */
export function sumCellTotal(
  transactions: ContributionTransaction[],
  type: ContributionType,
): number {
  return transactions
    .filter((t) => t.type === type && t.supersededAt === null)
    .reduce((acc, t) => acc + parseFloat(t.amount), 0);
}

/**
 * True iff the amber marker should render for a cell.
 *
 * Rule (settled with user before PR2 shipped):
 *   fire iff  AiTotal IS NOT NULL
 *        AND  NOT EXISTS (child WHERE type=cell.type
 *                               AND source='MANUAL'
 *                               AND supersededAt IS NULL)
 *        AND  abs(AiTotal
 *                 − Σ(child.amount WHERE type=cell.type
 *                                  AND source='AI'
 *                                  AND supersededAt IS NULL)) > 0.01
 *
 * Once a cell has a non-superseded MANUAL row (CA has taken
 * ownership), the marker suppresses entirely. The AI's original number
 * remains visible in the drill-down via superseded-row rendering; no
 * amber. Firing on every CA-corrected cell would train reviewers to
 * dismiss all amber and hide the real signal (AI's own arithmetic
 * disagreeing with its own transactions).
 */
export function shouldShowConflictMarker(
  aiTotal: string | null,
  transactions: ContributionTransaction[],
  type: ContributionType,
): boolean {
  if (aiTotal === null) return false;
  const relevant = transactions.filter(
    (t) => t.type === type && t.supersededAt === null,
  );
  const hasManual = relevant.some((t) => t.source === "MANUAL");
  if (hasManual) return false;
  const aiSum = relevant
    .filter((t) => t.source === "AI")
    .reduce((acc, t) => acc + parseFloat(t.amount), 0);
  return Math.abs(parseFloat(aiTotal) - aiSum) > 0.01;
}

/**
 * True iff any row in the grid (any of the 4 tax-year positions)
 * carries at least one non-superseded transaction of the given type.
 * Used by the completion counter: an unfilled grid drags the case's
 * displayed completion percentage down until a CA has engaged with it.
 */
export function isGridFilled(
  rows: ContributionRow[],
  type: ContributionType,
): boolean {
  return rows.some((row) =>
    row.transactions.some(
      (t) => t.type === type && t.supersededAt === null,
    ),
  );
}

/**
 * How much the two contributions grids contribute to a case's
 * completion tally. Applied to every counter that folds Fund Details
 * into its `+1` (ChecklistPanel, StageReviewChecklist,
 * ApprovalWorkspace, ExportWorkspace).
 *
 * Non-Pension plans return { add: 0, filled: 0 } — contributions are
 * a Pension-only construct in the canonical checklist spec.
 *
 * Shipping note: on Pension cases pre-PR3 (or any case where a CA has
 * not yet typed into the new grids), grids report 0 filled but add 2
 * to the denominator. Every existing Pension case's completion drops
 * by ~2 percentage points until a CA fills the grids. Correct
 * behaviour — a case reading 100% complete with no contributions data
 * was wrong on every completed case pre-PR3 — but visible, so the CA
 * team needs a heads-up before this ships. Recorded in the commit
 * message.
 */
export function contributionsProgress(
  rows: ContributionRow[],
  planType: string | null | undefined,
): { add: number; filled: number } {
  if (planType !== "PENSION") return { add: 0, filled: 0 };
  const employerFilled = isGridFilled(rows, "EMPLOYER");
  const personalFilled = isGridFilled(rows, "PERSONAL");
  return {
    add: 2,
    filled: (employerFilled ? 1 : 0) + (personalFilled ? 1 : 0),
  };
}
