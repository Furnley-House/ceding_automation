// frontend/src/hooks/useFundLines.ts
// Read + mutate the per-case Fund Details sub-table.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface FundLine {
  id: string;
  caseId: string;
  fundName: string;
  isinSedolCiti: string | null;
  numberOfUnits: string | null;   // Prisma Decimal serialised as string
  pricePerUnit: string | null;
  value: string | null;
  fundCharge: string | null;
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
  fundCharge?: string | number | null;
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
