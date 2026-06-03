// frontend/src/components/case/FundDetailsTable.tsx
// Renders the Fund Details sub-table for a case.
//   - readOnly mode → tidy table with totals (Stage 6 Review, Stage 8 Approval)
//   - editable mode → CA can add / edit / delete rows (Stage 4 Extract & Fill)
import { useMemo, useState } from "react";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useFundLines, type FundLine, type FundLineDraft } from "@/hooks/useFundLines";

function gbp(n: string | number | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const num = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(num)) return String(n);
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 2,
  }).format(num);
}

function num(n: string | number | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return String(n);
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 4 }).format(v);
}

function pct(n: string | number | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return String(n);
  return `${v.toFixed(2)}%`;
}

interface Props {
  caseId: string;
  /** When false (default), users can add / edit / delete rows. */
  readOnly?: boolean;
}

export function FundDetailsTable({ caseId, readOnly = false }: Props) {
  const { rows, summary, loading, error, addRow, updateRow, deleteRow } = useFundLines(caseId);
  const [draft, setDraft] = useState<FundLineDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        if (a.isWithProfits !== b.isWithProfits) return a.isWithProfits ? 1 : -1;
        return a.displayOrder - b.displayOrder;
      }),
    [rows],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading fund details…
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-3 text-xs text-destructive">
        Couldn't load fund details: {error}
      </div>
    );
  }

  const handleSaveDraft = async () => {
    if (!draft || !draft.fundName?.trim()) {
      toast.error("Fund name is required");
      return;
    }
    setSaving(true);
    try {
      await addRow(draft);
      setDraft(null);
      toast.success("Fund row added");
    } catch (err) {
      toast.error("Failed to add fund row", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row: FundLine) => {
    if (!confirm(`Remove ${row.fundName}?`)) return;
    try {
      await deleteRow(row.id);
      toast.success("Fund row removed");
    } catch (err) {
      toast.error("Failed to remove", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between">
        <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground">
          Fund Details
        </h4>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {summary.count} row{summary.count === 1 ? "" : "s"} · total {gbp(summary.totalValue)}
        </span>
      </div>

      {sorted.length === 0 && !draft ? (
        <div className="px-4 py-6 text-center text-xs text-muted-foreground italic">
          No fund rows extracted yet.
          {!readOnly && " Add the first one below."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/20 text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Fund Name</th>
                <th className="text-left px-3 py-2 font-semibold">ISIN / Sedol</th>
                <th className="text-right px-3 py-2 font-semibold">Units</th>
                <th className="text-right px-3 py-2 font-semibold">Price</th>
                <th className="text-right px-3 py-2 font-semibold">Value</th>
                <th className="text-right px-3 py-2 font-semibold">Charge</th>
                {!readOnly && <th className="px-3 py-2 w-8" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((r) => (
                <tr key={r.id} className="hover:bg-muted/20">
                  <td className="px-3 py-2 font-medium text-foreground">
                    {r.fundName}
                    {r.isWithProfits && (
                      <span className="ml-2 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-warning/15 text-warning font-semibold">
                        With-profits
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                    {r.isinSedolCiti ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(r.numberOfUnits)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{gbp(r.pricePerUnit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-foreground">
                    {gbp(r.value)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(r.fundCharge)}</td>
                  {!readOnly && (
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        onClick={() => handleDelete(r)}
                        className="text-muted-foreground hover:text-destructive"
                        title="Remove row"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {draft && !readOnly && (
                <tr className="bg-teal/5">
                  <td className="px-2 py-1">
                    <Input
                      autoFocus
                      value={draft.fundName ?? ""}
                      onChange={(e) => setDraft({ ...draft, fundName: e.target.value })}
                      placeholder="Fund name"
                      className="h-7 text-xs"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      value={(draft.isinSedolCiti as string) ?? ""}
                      onChange={(e) => setDraft({ ...draft, isinSedolCiti: e.target.value })}
                      placeholder="ISIN"
                      className="h-7 text-xs font-mono"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      type="number"
                      value={(draft.numberOfUnits as string) ?? ""}
                      onChange={(e) => setDraft({ ...draft, numberOfUnits: e.target.value })}
                      placeholder="0"
                      className="h-7 text-xs text-right"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      type="number"
                      step="0.0001"
                      value={(draft.pricePerUnit as string) ?? ""}
                      onChange={(e) => setDraft({ ...draft, pricePerUnit: e.target.value })}
                      placeholder="0.00"
                      className="h-7 text-xs text-right"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      type="number"
                      step="0.01"
                      value={(draft.value as string) ?? ""}
                      onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                      placeholder="0.00"
                      className="h-7 text-xs text-right"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      type="number"
                      step="0.01"
                      value={(draft.fundCharge as string) ?? ""}
                      onChange={(e) => setDraft({ ...draft, fundCharge: e.target.value })}
                      placeholder="0"
                      className="h-7 text-xs text-right"
                    />
                  </td>
                  <td className="px-2 py-1 text-right" />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!readOnly && (
        <div className="px-3 py-2 border-t border-border bg-muted/10 flex justify-end gap-2">
          {draft ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSaveDraft} disabled={saving} className="gap-1">
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                Save row
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setDraft({
                  fundName: "",
                  isinSedolCiti: "",
                  numberOfUnits: "",
                  pricePerUnit: "",
                  value: "",
                  fundCharge: "",
                })
              }
              className="h-7 gap-1 text-xs"
            >
              <Plus className="h-3.5 w-3.5" /> Add fund row
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
