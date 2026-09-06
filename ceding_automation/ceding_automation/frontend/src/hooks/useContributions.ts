// frontend/src/hooks/useContributions.ts
// Read + mutate the per-case Contributions table (4-year Pension history).
//
// Auto-seeded server-side on first GET: any case that has never opened the
// contributions view will get 4 rows with default UK-tax-year labels
// (position 1 = current tax year, 4 = current − 3). CAs can edit either
// the label or the amount per row via updateRow(), and reset the whole
// set via resetRows() if they want a clean re-seed.
//
// H33-followup PR3: rows now carry their non-superseded transaction
// children (`transactions`) and the AI's own per-cell totals
// (`employerAiTotal`, `personalAiTotal`). Manual entry writes via
// `addManualTransaction()` — POST to the PR2 endpoint which atomically
// supersedes prior rows in the cell and inserts one MANUAL child.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { contributionsApi } from "@/lib/api";
import { applyManualTransactionLocal } from "@/lib/contributionsDerivation";

export interface ContributionTransaction {
  id: string;
  contributionId: string;
  type: "EMPLOYER" | "PERSONAL";
  /** ISO date string (`YYYY-MM-DD`) or ISO datetime for @db.Date columns
   *  serialised by Prisma. NULL for manual entries (no source date). */
  date: string | null;
  /** Prisma Decimal serialised to string, e.g. "1234.56". */
  amount: string;
  description: string;
  documentId: string | null;
  sourcePage: number | null;
  sourceRef: string | null;
  source: "AI" | "MANUAL";
  /** ISO datetime string when superseded. GET filters at the query
   *  level (WHERE supersededAt IS NULL), so in this hook's data these
   *  are always null — but the field stays in the type for defensive
   *  client-side derivations and forwards-compatibility. */
  supersededAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContributionRow {
  id: string;
  caseId: string;
  /** 1 = current tax year, 4 = current − 3. Enforced by a unique index
   *  server-side; the row set is always exactly 4 items in position order. */
  position: number;
  taxYearLabel: string;
  /** Legacy single-total TEXT column, kept-and-deprecated per the PR1
   *  design session. The new two-grid UI does NOT read or write this
   *  column — it exists for the old single-grid UI and the export
   *  fallback until the pipeline emits per-row data. */
  amount: string | null;
  /** AI's own per-cell totals, emitted by the pipeline once piece 2b
   *  lands. Nullable (pre-piece-2b rows, out-of-window years, etc.).
   *  PRESERVED across CA overrides — see schema.prisma comment for
   *  the FH-2026-000188 forensics rationale. */
  employerAiTotal: string | null;
  personalAiTotal: string | null;
  /** Non-superseded child transactions; grouped by `type` on render.
   *  Empty array until PR3 manual entries or piece 2b AI emissions. */
  transactions: ContributionTransaction[];
  createdAt: string;
  updatedAt: string;
}

export function useContributions(caseId: string, enabled: boolean = true) {
  const [rows, setRows] = useState<ContributionRow[]>([]);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/cases/${caseId}/contributions`);
      const data = res.data as { rows?: ContributionRow[] };
      setRows(data.rows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [caseId, enabled]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await api.get(`/cases/${caseId}/contributions`);
        const data = res.data as { rows?: ContributionRow[] };
        if (!cancelled) setRows(data.rows ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId, enabled]);

  const updateRow = async (
    rowId: string,
    patch: { taxYearLabel?: string; amount?: string | null },
  ) => {
    // Optimistic update — the amount cell edit is the hot path and
    // waiting on a round-trip flickers the value back to old on blur.
    setRows((prev) =>
      prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)),
    );
    try {
      const res = await api.patch(`/cases/${caseId}/contributions/${rowId}`, patch);
      const updated = res.data as Omit<ContributionRow, "transactions"> &
        Partial<Pick<ContributionRow, "transactions">>;
      setRows((prev) =>
        prev.map((r) =>
          r.id === rowId
            ? { ...r, ...updated, transactions: updated.transactions ?? r.transactions }
            : r,
        ),
      );
    } catch (err) {
      // Roll back the optimistic patch on failure and rethrow so the caller
      // can surface a toast.
      await refresh();
      throw err;
    }
  };

  const resetRows = async () => {
    const res = await api.post(`/cases/${caseId}/contributions/reset`, {});
    const data = res.data as { rows?: ContributionRow[] };
    // Reset returns bare parent rows without the include; refresh so
    // the caller gets the full shape with `transactions: []` etc.
    setRows(data.rows ?? []);
    await refresh();
  };

  /**
   * Manual entry into a (contributionId, type) cell. POSTs to the PR2
   * endpoint which atomically supersedes any non-superseded prior rows
   * in that cell (both AI and MANUAL) and inserts ONE new MANUAL row.
   *
   * Local-state update — do NOT refresh(). refresh() flips `loading`
   * true, which unmounts the entire ContributionsTable body to a
   * "Loading contributions…" placeholder — that destroys the editing
   * input's focus mid-Tab flow (a CA typing amount + Tab + amount +
   * Tab across the 8 cells lost focus every save and had to click
   * into each cell) and unmounts any expanded drill-down. The POST
   * response has everything needed to reconstruct the post-supersede
   * shape via applyManualTransactionLocal.
   *
   * Trade-off: local state can drift from server if another user is
   * editing the same case concurrently. Rare (multi-CA on one case
   * simultaneously); the next page navigation picks up any drift. Not
   * worse than the checklist-field flow which also doesn't real-time
   * sync across users.
   */
  const addManualTransaction = async (
    rowId: string,
    type: "EMPLOYER" | "PERSONAL",
    amount: string | number,
  ) => {
    const res = await contributionsApi.addTransaction(caseId, rowId, { type, amount });
    // Backend returns a partial row (id, contributionId, type, amount,
    // description, source, createdAt) — reconstruct the full
    // ContributionTransaction locally. MANUAL entries have null date /
    // documentId / sourcePage / sourceRef / supersededAt by definition
    // (no source date, no source document — see contributionsService.ts
    // docstring for the "honest > made-up" rule).
    const partial = (res.data as {
      transaction: {
        id: string;
        contributionId: string;
        type: "EMPLOYER" | "PERSONAL";
        amount: string;
        description: string;
        source: "MANUAL";
        createdAt: string;
      };
    }).transaction;
    const newTxn: ContributionTransaction = {
      id: partial.id,
      contributionId: partial.contributionId,
      type: partial.type,
      date: null,
      amount: partial.amount,
      description: partial.description,
      documentId: null,
      sourcePage: null,
      sourceRef: null,
      source: "MANUAL",
      supersededAt: null,
      createdAt: partial.createdAt,
      updatedAt: partial.createdAt,
    };
    setRows((prev) => applyManualTransactionLocal(prev, rowId, newTxn));
  };

  return { rows, loading, error, refresh, updateRow, resetRows, addManualTransaction };
}
