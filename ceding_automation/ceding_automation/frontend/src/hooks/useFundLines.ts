// frontend/src/hooks/useFundLines.ts
// Read + mutate the per-case Fund Details sub-table.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

// Window event fired by code that writes fund lines (today: aiBffApply via
// the extraction completion signal in useDocuments). Mirrors the
// CHECKLIST_CHANGED_EVENT pattern in useChecklistFields — the hook is
// plain-state, not React Query, so a window event is the one place every
// mounted instance can hear.
export const FUND_LINES_CHANGED_EVENT = "ceding:fund-lines-changed";

export function notifyFundLinesChanged(caseId: string): void {
  window.dispatchEvent(
    new CustomEvent(FUND_LINES_CHANGED_EVENT, { detail: { caseId } }),
  );
}

export interface FundLine {
  id: string;
  caseId: string;
  fundName: string;
  isinSedolCiti: string | null;
  numberOfUnits: string | null;   // Prisma Decimal serialised as string
  pricePerUnit: string | null;
  value: string | null;
  ocf: string | null;
  transactionCosts: string | null;
  isWithProfits: boolean;
  sourceDocumentId: string | null;
  sourcePageNumber: number | null;
  sourceQuote: string | null;
  displayOrder: number;
  status: string;
  confidence: string;
  createdAt: string;
  updatedAt: string;
}

export interface FundLineSummary {
  count: number;
  withProfitsCount: number;
  totalValue: string;
}

export interface FundLineDraft {
  fundName: string;
  isinSedolCiti?: string | null;
  numberOfUnits?: string | number | null;
  pricePerUnit?: string | number | null;
  value?: string | number | null;
  ocf?: string | number | null;
  transactionCosts?: string | number | null;
  isWithProfits?: boolean;
}

export function useFundLines(caseId: string) {
  const [rows, setRows] = useState<FundLine[]>([]);
  const [summary, setSummary] = useState<FundLineSummary>({
    count: 0,
    withProfitsCount: 0,
    totalValue: "0",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/cases/${caseId}/fund-lines`);
      const data = res.data as { rows?: FundLine[]; summary?: FundLineSummary };
      setRows(data.rows ?? []);
      setSummary(data.summary ?? { count: 0, withProfitsCount: 0, totalValue: "0" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await api.get(`/cases/${caseId}/fund-lines`);
        const data = res.data as { rows?: FundLine[]; summary?: FundLineSummary };
        if (!cancelled) {
          setRows(data.rows ?? []);
          setSummary(data.summary ?? { count: 0, withProfitsCount: 0, totalValue: "0" });
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [caseId]);

  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ caseId: string }>).detail;
      if (d?.caseId === caseId) void refresh();
    };
    window.addEventListener(FUND_LINES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(FUND_LINES_CHANGED_EVENT, onChanged);
  }, [caseId, refresh]);

  const addRow = async (draft: FundLineDraft) => {
    await api.post(`/cases/${caseId}/fund-lines`, draft);
    await refresh();
  };

  const updateRow = async (lineId: string, patch: Partial<FundLineDraft>) => {
    await api.patch(`/cases/${caseId}/fund-lines/${lineId}`, patch);
    await refresh();
  };

  const deleteRow = async (lineId: string) => {
    await api.delete(`/cases/${caseId}/fund-lines/${lineId}`);
    await refresh();
  };

  return { rows, summary, loading, error, refresh, addRow, updateRow, deleteRow };
}
