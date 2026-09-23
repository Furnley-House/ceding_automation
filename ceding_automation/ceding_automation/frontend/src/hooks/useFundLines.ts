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

  // ── Stage-6 verification ────────────────────────────────────────────────
  // Written by POST /fund-lines/verify. Null on every row until it has run,
  // and cleared again if the CA edits the identifier, because a resolved
  // fund that was matched from a different identifier is worse than none.
  /** The ISIN the identifier resolved to — matched directly or via a GB SEDOL. */
  resolvedIsin: string | null;
  resolvedFundName: string | null;
  resolvedUnitPrice: string | null;   // Decimal serialised as string
  resolvedPriceDate: string | null;
  resolvedOcf: string | null;
  resolvedTxCost: string | null;
  verifiedAt: string | null;
  /** AMBER = name and price both resolved; RED = one or both did not. */
  holdingRag: "RED" | "AMBER" | null;
  fundNameSource: "CEDING" | "LOOKUP" | null;
  priceSource: "CEDING" | "LOOKUP" | null;
  ocfSource: "CEDING" | "LOOKUP" | null;
  txCostSource: "CEDING" | "LOOKUP" | null;
}

export interface VerificationSummary {
  caseId: string;
  total: number;
  checked: number;
  amber: number;
  red: number;
  skipped: number;
}

/** Which figure gets pushed to CRM for each field of a holding. */
export interface SourceChoice {
  fundNameSource?: "CEDING" | "LOOKUP";
  priceSource?: "CEDING" | "LOOKUP";
  ocfSource?: "CEDING" | "LOOKUP";
  txCostSource?: "CEDING" | "LOOKUP";
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

  // Resolve every holding against the fund master and FE Fund Info. The
  // response already carries the refreshed rows, so this sets them directly
  // rather than round-tripping the list again.
  const verify = async (): Promise<VerificationSummary> => {
    const res = await api.post(`/cases/${caseId}/fund-lines/verify`);
    const data = res.data as { summary: VerificationSummary; fundLines?: FundLine[] };
    if (data.fundLines) setRows(data.fundLines);
    else await refresh();
    return data.summary;
  };

  // Record which figure the CA wants carried into CRM for one field. Patches
  // the single row in place — re-fetching the whole table would scroll the
  // panel out from under them mid-decision.
  const setSource = async (lineId: string, choice: SourceChoice) => {
    const res = await api.patch(`/cases/${caseId}/fund-lines/${lineId}/source`, choice);
    const updated = res.data as FundLine;
    setRows((prev) => prev.map((r) => (r.id === lineId ? { ...r, ...updated } : r)));
  };

  return {
    rows,
    summary,
    loading,
    error,
    refresh,
    addRow,
    updateRow,
    deleteRow,
    verify,
    setSource,
  };
}
