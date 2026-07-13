// frontend/src/components/case/FundDetailsTable.tsx
// Renders the Fund Details sub-table for a case.
//   - readOnly mode → tidy table with totals (Stage 6 Review, Stage 8 Approval)
//   - editable mode → CA can add / edit / delete rows (Stage 4 Extract & Fill)
//     Editable cells: click a cell → in-place Input → blur / Enter saves via
//     updateRow, Escape cancels. One cell at a time; other cells stay display-only.
import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Plus, Trash2, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useFundLines, type FundLine, type FundLineDraft } from "@/hooks/useFundLines";
import { FundDetailsImportDialog } from "./FundDetailsImportDialog";

// Which FundLineDraft keys are inline-editable via a cell click. Excludes
// isWithProfits (renders as a badge, toggle would need a different UX) and
// backend-managed fields (id, createdAt, etc.).
type EditableField =
  | "fundName"
  | "isinSedolCiti"
  | "numberOfUnits"
  | "pricePerUnit"
  | "value"
  | "ocf"
  | "transactionCosts";

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
  const { rows, summary, loading, error, refresh, addRow, updateRow, deleteRow } = useFundLines(caseId);
  const [draft, setDraft] = useState<FundLineDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // ── Inline-edit state ────────────────────────────────────────────────────
  // Only one cell can be in edit mode at a time. `value` is the current
  // input contents; `original` snapshots the value at edit-start so Escape
  // can revert and blur-with-no-change can skip the network call.
  const [editing, setEditing] = useState<{
    rowId: string;
    field: EditableField;
    value: string;
    original: string;
  } | null>(null);
  const [cellSaving, setCellSaving] = useState(false);
  // Guards against double-save when Enter (which blurs the input) fires both
  // onKeyDown and onBlur handlers in the same commit.
  const commitInFlight = useRef(false);

  const startEdit = (row: FundLine, field: EditableField) => {
    if (readOnly || editing || cellSaving) return;
    const current = ((row[field] as string | null) ?? "").toString();
    setEditing({ rowId: row.id, field, value: current, original: current });
  };

  const cancelEdit = () => {
    setEditing(null);
  };

  const commitEdit = async () => {
    if (!editing || commitInFlight.current) return;
    // No-op if value unchanged — skip the round-trip.
    if (editing.value === editing.original) {
      setEditing(null);
      return;
    }
    commitInFlight.current = true;
    setCellSaving(true);
    try {
      const patch: Partial<FundLineDraft> = {
        // Empty string → null so backend clears the field rather than storing "".
        [editing.field]: editing.value === "" ? null : editing.value,
      };
      await updateRow(editing.rowId, patch);
      setEditing(null);
    } catch (err) {
      toast.error("Failed to update fund row", {
        description: err instanceof Error ? err.message : String(err),
      });
      // Leave editing state up so the user can retry without re-typing.
    } finally {
      setCellSaving(false);
      commitInFlight.current = false;
    }
  };

  const handleCellKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  // Renders either the display value (with click-to-edit affordance) or an
  // Input if this cell is currently being edited. `formatted` is what to
  // show in view mode; `rawInputType` shapes the Input when in edit mode.
  const renderEditableCell = (
    row: FundLine,
    field: EditableField,
    formatted: string,
    rawInputType: "text" | "number",
    inputStep?: string,
    extraInputClassName?: string,
  ) => {
    const isEditing = editing?.rowId === row.id && editing.field === field;
    if (isEditing) {
      return (
        <Input
          autoFocus
          type={rawInputType}
          step={inputStep}
          value={editing.value}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onBlur={() => void commitEdit()}
          onKeyDown={handleCellKey}
          disabled={cellSaving}
          className={`h-7 text-xs ${extraInputClassName ?? ""}`}
        />
      );
    }
    if (readOnly) {
      return <span className="text-foreground">{formatted}</span>;
    }
    return (
      <button
        type="button"
        onClick={() => startEdit(row, field)}
        className="w-full text-left cursor-text hover:bg-muted/40 rounded px-1 -mx-1 py-0.5 -my-0.5 transition-colors"
        title="Click to edit"
      >
        {formatted}
      </button>
    );
  };

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
                <th className="text-right px-3 py-2 font-semibold">OCF</th>
                <th className="text-right px-3 py-2 font-semibold">Transaction Costs</th>
                {!readOnly && <th className="px-3 py-2 w-8" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((r) => (
                <tr key={r.id} className="hover:bg-muted/20">
                  <td className="px-3 py-2 font-medium text-foreground">
                    {renderEditableCell(r, "fundName", r.fundName || "—", "text")}
                    {r.isWithProfits && (
                      <span className="ml-2 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-warning/15 text-warning font-semibold">
                        With-profits
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                    {renderEditableCell(r, "isinSedolCiti", r.isinSedolCiti ?? "—", "text", undefined, "font-mono")}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {renderEditableCell(r, "numberOfUnits", num(r.numberOfUnits), "number", "0.0001", "text-right")}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {renderEditableCell(r, "pricePerUnit", gbp(r.pricePerUnit), "number", "0.0001", "text-right")}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-foreground">
                    {renderEditableCell(r, "value", gbp(r.value), "number", "0.01", "text-right")}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {renderEditableCell(r, "ocf", pct(r.ocf), "number", "0.0001", "text-right")}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {renderEditableCell(r, "transactionCosts", pct(r.transactionCosts), "number", "0.0001", "text-right")}
                  </td>
                  {!readOnly && (
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        onClick={() => handleDelete(r)}
                        className="text-muted-foreground hover:text-destructive"
                        title="Remove row"
                        disabled={cellSaving}
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
                      step="0.0001"
                      value={(draft.ocf as string) ?? ""}
                      onChange={(e) => setDraft({ ...draft, ocf: e.target.value })}
                      placeholder="0"
                      className="h-7 text-xs text-right"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      type="number"
                      step="0.0001"
                      value={(draft.transactionCosts as string) ?? ""}
                      onChange={(e) => setDraft({ ...draft, transactionCosts: e.target.value })}
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

      {!readOnly && sorted.length > 0 && !draft && (
        <div className="px-3 py-1 text-[10px] text-muted-foreground italic border-t border-border/50">
          Click any cell to edit — Enter saves, Escape cancels.
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
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setImportOpen(true)}
                className="h-7 gap-1 text-xs"
              >
                <Upload className="h-3.5 w-3.5" /> Import from Excel
              </Button>
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
                    ocf: "",
                    transactionCosts: "",
                  })
                }
                className="h-7 gap-1 text-xs"
              >
                <Plus className="h-3.5 w-3.5" /> Add fund row
              </Button>
            </>
          )}
        </div>
      )}

      {importOpen && (
        <FundDetailsImportDialog
          caseId={caseId}
          onClose={() => setImportOpen(false)}
          onImported={refresh}
        />
      )}
    </div>
  );
}
