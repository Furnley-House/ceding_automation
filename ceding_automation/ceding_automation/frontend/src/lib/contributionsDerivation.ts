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
 * Four render states for a contribution cell:
 *   - "amount"          — has non-superseded transactions summing to > 0
 *   - "zero"            — has non-superseded transactions summing to 0
 *                         (a real "contributions existed and totalled £0")
 *   - "notApplicable"   — cell has been explicitly marked N/A by a CA
 *   - "empty"           — nothing here yet
 *
 * H33-followup PR5 introduced "notApplicable" as its own state. Empty
 * and N/A used to be indistinguishable ("None found" in both cases),
 * which meant a paraplanner couldn't tell "no employer scheme" apart
 * from "the CA hasn't got to this cell yet" — a decision-quality
 * problem at the Stage 6 sign-off.
 */
export type ContributionCellState =
  | { kind: "amount"; total: number }
  | { kind: "zero" }
  | { kind: "notApplicable" }
  | { kind: "empty" };

/** Read the N/A flag off the parent row for one type. */
export function isCellNotApplicable(
  row: Pick<ContributionRow, "employerNotApplicableAt" | "personalNotApplicableAt">,
  type: ContributionType,
): boolean {
  return type === "EMPLOYER"
    ? row.employerNotApplicableAt !== null
    : row.personalNotApplicableAt !== null;
}

/**
 * Resolve one cell to its four-state render shape. Used by both the
 * editable ContributionCell and the read-only Stage-6/8 rendering so
 * the visual language is identical everywhere.
 *
 * N/A takes precedence over transactions — if a cell is flagged N/A,
 * even a stray non-superseded transaction (there shouldn't be one; the
 * server supersedes them on flip) would still render as "notApplicable".
 * This is deliberate belt-and-braces against a partial write.
 */
export function cellState(
  row: ContributionRow,
  type: ContributionType,
): ContributionCellState {
  if (isCellNotApplicable(row, type)) return { kind: "notApplicable" };
  const relevant = row.transactions.filter(
    (t) => t.type === type && t.supersededAt === null,
  );
  if (relevant.length === 0) return { kind: "empty" };
  const total = relevant.reduce((acc, t) => acc + parseFloat(t.amount), 0);
  if (total === 0) return { kind: "zero" };
  return { kind: "amount", total };
}

/**
 * Sum a cell's non-superseded transactions of the given type.
 * Backend already filters supersededAt at the query level so the
 * `.filter` here defends against future include-superseded changes
 * (e.g. a PR3 drill-down variant that fetches both).
 *
 * Kept as a raw sum (does NOT respect the N/A flag) because two
 * callers still want the raw arithmetic: the conflict-marker rule
 * compares AiTotal against the raw sum, and the Stage-4 grid total
 * folds N/A into "excluded" separately via cellState. If you want
 * "the number the UI shows", call cellState() and match on kind.
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
  isNotApplicable: boolean = false,
): boolean {
  // PR5: an N/A flip is the human saying "this cell doesn't apply".
  // The AI's total is irrelevant at that point — suppress the marker
  // the same way we do when the CA has taken ownership via a MANUAL
  // row. Same "don't train reviewers to dismiss all amber" reasoning.
  if (isNotApplicable) return false;
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
 * counts as "the CA has engaged with this cell". Includes both
 * "has non-superseded transactions" AND "flagged N/A".
 *
 * PR5: N/A counts as engagement — the CA has made a decision about
 * the cell (deliberately: not applicable). This does mean a grid
 * with all four cells N/A reads as "filled" for the completion
 * tally, which is CORRECT — the CA has fully addressed the grid —
 * even though it looks like "no data was captured". Do NOT revert
 * this thinking it's a bug; the intent is "has the human moved
 * through this cell", not "was a number written".
 */
export function isGridFilled(
  rows: ContributionRow[],
  type: ContributionType,
): boolean {
  return rows.some(
    (row) =>
      isCellNotApplicable(row, type) ||
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

/**
 * Apply the result of a successful POST /contributions/:id/transactions
 * to a local rows array — without refetching. Mirrors PR2's server-side
 * supersede-ALL: strips any non-superseded rows in the same
 * (rowId, newTxn.type) cell (which the server just superseded atomically)
 * and appends the new MANUAL row. Other cells are untouched, superseded
 * rows in the same cell are untouched (they belong to the drill-down
 * history, once a variant of GET starts returning them).
 *
 * This replaced a `refresh()` call after every manual save. Refresh
 * flipped useContributions.loading → true, which unmounted the entire
 * ContributionsTable body to a "Loading contributions…" placeholder,
 * which (a) destroyed the editing input's focus mid-Tab flow — a CA
 * typing amount + Tab + amount + Tab across 8 cells lost focus every
 * time and had to click into each cell — and (b) briefly unmounted
 * any expanded drill-down. The POST response has everything needed to
 * reconstruct the post-supersede local state, so no refetch is needed.
 */
export function applyManualTransactionLocal(
  rows: ContributionRow[],
  rowId: string,
  newTxn: ContributionTransaction,
): ContributionRow[] {
  return rows.map((r) => {
    if (r.id !== rowId) return r;
    return {
      ...r,
      // Typing a number into a cell that was previously N/A clears
      // the N/A flag — the CA has stated the cell IS applicable by
      // entering a value. Matches the server's implicit behaviour
      // (createManualContributionTransaction doesn't touch the flag,
      // but the UI won't reach that path for an N/A cell without the
      // user first clearing it).
      ...(newTxn.type === "EMPLOYER"
        ? { employerNotApplicableAt: null, employerNotApplicableById: null }
        : { personalNotApplicableAt: null, personalNotApplicableById: null }),
      transactions: [
        // Drop only non-superseded rows of the SAME type — mirrors the
        // server's WHERE contributionId=? AND type=? AND supersededAt
        // IS NULL. Rows of the other type stay put (type-scoped
        // supersede); already-superseded rows stay put (audit history).
        ...r.transactions.filter(
          (t) => !(t.type === newTxn.type && t.supersededAt === null),
        ),
        newTxn,
      ],
    };
  });
}

/**
 * Apply the result of a successful POST
 * /contributions/:id/not-applicable to a local rows array — without
 * refetching. Symmetric to applyManualTransactionLocal.
 *
 * When setting N/A, we mirror the server's supersede-then-flag:
 * strip non-superseded rows of that type from local state (the
 * server just superseded them) and set the paired flag columns.
 * When clearing, we just null the flag columns; the transactions
 * that were superseded when the flag was set stay superseded (see
 * KI-05 for the "clear doesn't un-supersede" trade-off).
 */
export function applyNotApplicableLocal(
  rows: ContributionRow[],
  rowId: string,
  type: ContributionType,
  on: boolean,
  atIso: string | null,
  byId: string | null,
): ContributionRow[] {
  return rows.map((r) => {
    if (r.id !== rowId) return r;
    const flagPatch =
      type === "EMPLOYER"
        ? {
            employerNotApplicableAt: on ? atIso : null,
            employerNotApplicableById: on ? byId : null,
          }
        : {
            personalNotApplicableAt: on ? atIso : null,
            personalNotApplicableById: on ? byId : null,
          };
    const transactions = on
      ? // Setting: strip non-superseded rows of this type (server
        // superseded them atomically).
        r.transactions.filter(
          (t) => !(t.type === type && t.supersededAt === null),
        )
      : r.transactions;
    return { ...r, ...flagPatch, transactions };
  });
}
