// frontend/src/hooks/useContributions.ts
// Read + mutate the per-case Contributions table (4-year Pension history).
//
// Auto-seeded server-side on first GET: any case that has never opened the
// contributions view will get 4 rows with default UK-tax-year labels
// (position 1 = current tax year, 4 = current − 3). CAs can edit either
// the label or the amount per row via updateRow(), and reset the whole
// set via resetRows() if they want a clean re-seed.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface ContributionRow {
  id: string;
  caseId: string;
  /** 1 = current tax year, 4 = current − 3. Enforced by a unique index
   *  server-side; the row set is always exactly 4 items in position order. */
  position: number;
  taxYearLabel: string;
  amount: string | null;
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
      const updated = res.data as ContributionRow;
      setRows((prev) => prev.map((r) => (r.id === rowId ? updated : r)));
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
    setRows(data.rows ?? []);
  };

  return { rows, loading, error, refresh, updateRow, resetRows };
}
