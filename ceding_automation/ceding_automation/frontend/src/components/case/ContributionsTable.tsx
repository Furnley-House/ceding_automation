// frontend/src/components/case/ContributionsTable.tsx
// 4-column × 2-row Contributions table for Pension cases.
// - Row 1: tax-year labels (editable)
// - Row 2: amounts per year (editable)
// Renders on Stage 4 (Extract & Fill Gaps) inside the Transaction History
// section — replaces the two legacy free-text fields
// (contributions_4yr_history + contributions_breakdown_employer_personal)
// which are hidden from the checklist UI. Those fields are still stored
// on ChecklistField as a raw AI-extracted fallback.

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useContributions, type ContributionRow } from "@/hooks/useContributions";

interface Props {
  caseId: string;
  readOnly?: boolean;
}

export function ContributionsTable({ caseId, readOnly = false }: Props) {
  const { rows, loading, updateRow, resetRows } = useContributions(caseId);

  const orderedRows = [...rows].sort((a, b) => a.position - b.position);

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
        <div>
          <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground">
            Contributions — this tax year + previous 3
          </h4>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Proof of past 4 years of transactions required. Amounts default
            to blank; edit labels if the source document uses different
            tax-year notation.
          </p>
        </div>
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-[11px]"
            onClick={async () => {
              const ok = window.confirm(
                "Reset all 4 tax-year labels to defaults? Amounts will be cleared.",
              );
              if (!ok) return;
              try {
                await resetRows();
                toast.success("Reset contributions rows");
              } catch (err) {
                toast.error(
                  "Reset failed",
                  { description: err instanceof Error ? err.message : String(err) },
                );
              }
            }}
            title="Reset labels + clear amounts"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </Button>
        )}
      </div>

      {loading ? (
        <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
          Loading contributions…
        </p>
      ) : orderedRows.length === 0 ? (
        <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
          No contributions yet.
        </p>
      ) : (
        <div className="grid grid-cols-4 divide-x divide-border">
          {orderedRows.map((row, idx) => (
            <ContributionCell
              key={row.id}
              row={row}
              readOnly={readOnly}
              onUpdate={updateRow}
              isFirst={idx === 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ContributionCell({
  row,
  readOnly,
  onUpdate,
  isFirst,
}: {
  row: ContributionRow;
  readOnly: boolean;
  onUpdate: (rowId: string, patch: { taxYearLabel?: string; amount?: string | null }) => Promise<void>;
  isFirst: boolean;
}) {
  return (
    <div className="flex flex-col">
      {/* Row 1: tax-year label */}
      <EditableCell
        value={row.taxYearLabel}
        readOnly={readOnly}
        placeholder="YYYY/YY"
        className="border-b border-border bg-muted/20 text-center font-semibold text-[11px] py-2"
        onCommit={async (v) => {
          if (v === row.taxYearLabel) return;
          try {
            await onUpdate(row.id, { taxYearLabel: v });
          } catch (err) {
            toast.error("Couldn't save tax year", {
              description: err instanceof Error ? err.message : String(err),
            });
          }
        }}
        label={isFirst ? "Tax year" : undefined}
      />
      {/* Row 2: amount */}
      <EditableCell
        value={row.amount ?? ""}
        readOnly={readOnly}
        placeholder="£0.00"
        className="text-center text-sm py-3"
        onCommit={async (v) => {
          const clean = v.trim();
          if (clean === (row.amount ?? "")) return;
          try {
            await onUpdate(row.id, { amount: clean || null });
          } catch (err) {
            toast.error("Couldn't save amount", {
              description: err instanceof Error ? err.message : String(err),
            });
          }
        }}
        label={isFirst ? "Amount" : undefined}
      />
    </div>
  );
}

function EditableCell({
  value,
  readOnly,
  placeholder,
  className,
  onCommit,
  label,
}: {
  value: string;
  readOnly: boolean;
  placeholder: string;
  className: string;
  onCommit: (nextValue: string) => Promise<void>;
  label?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const start = () => {
    if (readOnly) return;
    setDraft(value);
    setEditing(true);
  };
  const commit = async (nextValue: string) => {
    setEditing(false);
    await onCommit(nextValue);
  };

  // Row hint chip on the leftmost column, shown once so CAs know which
  // row is which. Rendered as an absolutely-positioned strip inside the
  // cell so it doesn't disrupt the 4-column grid alignment.
  return (
    <div
      className={`relative ${className} ${readOnly ? "" : "cursor-text hover:bg-muted/40"}`}
      onClick={editing ? undefined : start}
    >
      {label && (
        <span className="absolute left-1.5 top-1.5 text-[9px] uppercase tracking-wider text-muted-foreground font-semibold pointer-events-none">
          {label}
        </span>
      )}
      {editing ? (
        <input
          type="text"
          autoFocus
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
              setDraft(value);
            }
          }}
          className="w-full bg-transparent text-center outline-none focus:ring-1 focus:ring-teal rounded px-1"
        />
      ) : (
        <span className={value ? "text-foreground" : "text-muted-foreground italic"}>
          {value || placeholder}
        </span>
      )}
    </div>
  );
}
