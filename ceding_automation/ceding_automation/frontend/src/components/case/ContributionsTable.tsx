// frontend/src/components/case/ContributionsTable.tsx
//
// H33-followup PR3: two-grid contributions UI for Pension cases.
//
// Layout: one "Contributions" header, then two stacked grids (Employer,
// Personal) each 4 columns × 2 rows (tax-year label + cell total).
// Click a cell total's chevron to expand a per-row drill-down of the
// transactions behind that total (date | description | amount | page
// | source badge). Amber marker fires only when the AI's own total
// disagrees with its own transactions AND the cell has no
// non-superseded MANUAL row — see contributionsDerivation.ts for the
// exact rule and its rationale.
//
// Manual entry preserves Carmel's type-a-number workflow: click a
// cell, type a number, blur or Enter to save. Under the hood it POSTs
// to /:caseId/contributions/:id/transactions (PR2), which atomically
// supersedes any non-superseded prior rows in that (contribution,
// type) cell and inserts one MANUAL child. The parent's
// *AiTotal column is PRESERVED — see schema.prisma docstring for the
// FH-2026-000188 forensics rationale.
//
// Empty cells read "None found" (not blank) — spec from the design
// session. A blank cell looks like a failure; "None found" reads as
// an intentional zero, which is what CAs want to see when the AI
// genuinely extracted no transactions for that year.

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  useContributions,
  type ContributionRow,
  type ContributionTransaction,
} from "@/hooks/useContributions";
import {
  sumCellTotal,
  shouldShowConflictMarker,
  type ContributionType,
} from "@/lib/contributionsDerivation";

const TYPES: readonly ContributionType[] = ["EMPLOYER", "PERSONAL"] as const;

interface Props {
  caseId: string;
  readOnly?: boolean;
}

interface ExpandedCell {
  rowId: string;
  type: ContributionType;
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(n);
}

// ── Root ────────────────────────────────────────────────────────────────

export function ContributionsTable({ caseId, readOnly = false }: Props) {
  const { rows, loading, updateRow, resetRows, addManualTransaction } =
    useContributions(caseId);
  const [expanded, setExpanded] = useState<ExpandedCell | null>(null);

  const orderedRows = [...rows].sort((a, b) => a.position - b.position);

  const toggleExpand = (rowId: string, type: ContributionType) => {
    setExpanded((cur) =>
      cur?.rowId === rowId && cur?.type === type ? null : { rowId, type },
    );
  };

  const handleManualEntry = async (
    rowId: string,
    type: ContributionType,
    amount: string,
  ) => {
    try {
      await addManualTransaction(rowId, type, amount);
    } catch (err) {
      toast.error("Couldn't save contribution", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleReset = async () => {
    const ok = window.confirm(
      "Reset all 4 tax-year labels and delete all contribution transactions " +
        "(both AI-extracted and manual entries)? This cannot be undone.",
    );
    if (!ok) return;
    try {
      await resetRows();
      setExpanded(null);
      toast.success("Contributions reset");
    } catch (err) {
      toast.error("Reset failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
        <div>
          <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground">
            Contributions — this tax year + previous 3
          </h4>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Employer + personal, per year. Click a total's chevron to see
            the transactions behind it.
          </p>
        </div>
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-[11px]"
            onClick={handleReset}
            title="Reset labels + delete all contribution entries"
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
        TYPES.map((type) => (
          <TypeGrid
            key={type}
            type={type}
            rows={orderedRows}
            readOnly={readOnly}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            onManualEntry={handleManualEntry}
            // Only the EMPLOYER grid exposes tax-year label editing to
            // avoid two edit affordances for the same underlying
            // parent field. Personal grid renders the labels read-only.
            onUpdateLabel={type === "EMPLOYER" ? updateRow : undefined}
          />
        ))
      )}
    </div>
  );
}

// ── Per-type grid ────────────────────────────────────────────────────────

interface TypeGridProps {
  type: ContributionType;
  rows: ContributionRow[];
  readOnly: boolean;
  expanded: ExpandedCell | null;
  onToggleExpand: (rowId: string, type: ContributionType) => void;
  onManualEntry: (rowId: string, type: ContributionType, amount: string) => Promise<void>;
  onUpdateLabel?: (rowId: string, patch: { taxYearLabel: string }) => Promise<void>;
}

function TypeGrid({
  type,
  rows,
  readOnly,
  expanded,
  onToggleExpand,
  onManualEntry,
  onUpdateLabel,
}: TypeGridProps) {
  const label = type === "EMPLOYER" ? "Employer" : "Personal";
  const isExpandedHere = expanded !== null && expanded.type === type;
  const expandedRow = isExpandedHere
    ? rows.find((r) => r.id === expanded!.rowId)
    : undefined;

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="px-3 py-1.5 bg-muted/10 border-b border-border">
        <h5 className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
          {label}
        </h5>
      </div>
      <div className="grid grid-cols-4 divide-x divide-border">
        {rows.map((row) => (
          <ContributionCell
            key={`${row.id}-${type}`}
            row={row}
            type={type}
            readOnly={readOnly}
            isExpanded={
              expanded?.rowId === row.id && expanded?.type === type
            }
            onToggleExpand={() => onToggleExpand(row.id, type)}
            onManualEntry={(amount) => onManualEntry(row.id, type, amount)}
            onUpdateLabel={
              onUpdateLabel
                ? (v) => onUpdateLabel(row.id, { taxYearLabel: v })
                : undefined
            }
          />
        ))}
      </div>
      {expandedRow && (
        <TransactionDrillDown row={expandedRow} type={type} />
      )}
    </div>
  );
}

// ── Per-cell renderer ────────────────────────────────────────────────────

interface ContributionCellProps {
  row: ContributionRow;
  type: ContributionType;
  readOnly: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onManualEntry: (amount: string) => Promise<void>;
  onUpdateLabel?: (nextLabel: string) => Promise<void>;
}

function ContributionCell({
  row,
  type,
  readOnly,
  isExpanded,
  onToggleExpand,
  onManualEntry,
  onUpdateLabel,
}: ContributionCellProps) {
  const [editing, setEditing] = useState(false);

  const cellTxns = row.transactions.filter(
    (t) => t.type === type && t.supersededAt === null,
  );
  const hasTransactions = cellTxns.length > 0;
  const sum = sumCellTotal(row.transactions, type);
  const aiTotal =
    type === "EMPLOYER" ? row.employerAiTotal : row.personalAiTotal;
  const showMarker = shouldShowConflictMarker(aiTotal, row.transactions, type);

  const aiChildren = cellTxns.filter((t) => t.source === "AI");
  const aiSum = aiChildren.reduce((acc, t) => acc + parseFloat(t.amount), 0);
  const markerMessage = aiTotal
    ? `AI read ${formatCurrency(parseFloat(aiTotal))}, sum of ${aiChildren.length} ` +
      `transaction${aiChildren.length === 1 ? "" : "s"} is ${formatCurrency(aiSum)} ` +
      "— please check"
    : "";

  const startEdit = () => {
    if (readOnly) return;
    setEditing(true);
  };
  const commit = async (raw: string) => {
    setEditing(false);
    const clean = raw.trim().replace(/[£,\s]/g, "");
    if (!clean) return;
    await onManualEntry(clean);
  };

  return (
    <div className="flex flex-col">
      {/* Row 1: tax-year label (editable only in EMPLOYER grid) */}
      <YearLabelCell
        value={row.taxYearLabel}
        editable={!readOnly && !!onUpdateLabel}
        onCommit={onUpdateLabel}
      />

      {/* Row 2: total + chevron + optional conflict marker */}
      <div className="relative min-h-[42px] px-2 py-2 text-center text-sm">
        {editing ? (
          <input
            type="text"
            autoFocus
            defaultValue=""
            placeholder="£0.00"
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit((e.target as HTMLInputElement).value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            className="w-full bg-transparent text-center outline-none focus:ring-1 focus:ring-teal rounded px-1"
          />
        ) : (
          <div className="flex items-center justify-center gap-1">
            <button
              type="button"
              onClick={startEdit}
              // Auto-enter edit mode on focus (Tab or click) so the
              // Tab-Type-Tab-Type flow across 8 cells works in one pass
              // without pressing Space/Enter per cell. Idempotent: if
              // already editing, setEditing(true) is a no-op.
              onFocus={startEdit}
              disabled={readOnly}
              className={`flex-1 text-center ${
                readOnly ? "cursor-default" : "cursor-text hover:bg-muted/40 rounded px-1"
              }`}
              title={readOnly ? undefined : "Click to type a value"}
            >
              {hasTransactions ? (
                <span className="text-foreground font-medium">
                  {formatCurrency(sum)}
                </span>
              ) : (
                <span className="text-muted-foreground italic text-xs">
                  None found
                </span>
              )}
            </button>
            {hasTransactions && (
              <button
                type="button"
                onClick={onToggleExpand}
                // Off the Tab flow — CAs Tab through amount cells only.
                // Chevron is mouse-only; keyboard drill-down can be
                // added later if requested.
                tabIndex={-1}
                title={isExpanded ? "Hide transactions" : "View transactions"}
                aria-label={isExpanded ? "Hide transactions" : "View transactions"}
                className="p-0.5 rounded hover:bg-muted flex-shrink-0"
              >
                {isExpanded ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </button>
            )}
            {showMarker && (
              <span
                title={markerMessage}
                aria-label={markerMessage}
                className="p-0.5 rounded flex-shrink-0"
              >
                <AlertTriangle className="h-3 w-3 text-amber-600" />
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tax-year label (editable) ────────────────────────────────────────────

function YearLabelCell({
  value,
  editable,
  onCommit,
}: {
  value: string;
  editable: boolean;
  onCommit?: (nextLabel: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);

  const baseCls =
    "border-b border-border bg-muted/20 text-center font-semibold text-[11px] py-2";

  if (!editable || !onCommit) {
    return <div className={baseCls}>{value}</div>;
  }

  const commit = async (raw: string) => {
    setEditing(false);
    const clean = raw.trim();
    if (!clean || clean === value) return;
    try {
      await onCommit(clean);
    } catch (err) {
      toast.error("Couldn't save tax year", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div
      className={`${baseCls} cursor-text hover:bg-muted/40`}
      onClick={editing ? undefined : () => setEditing(true)}
    >
      {editing ? (
        <input
          type="text"
          autoFocus
          defaultValue={value}
          placeholder="YYYY/YY"
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          className="w-full bg-transparent text-center outline-none focus:ring-1 focus:ring-teal rounded px-1"
        />
      ) : (
        value
      )}
    </div>
  );
}

// ── Drill-down: transactions behind a cell total ────────────────────────

function TransactionDrillDown({
  row,
  type,
}: {
  row: ContributionRow;
  type: ContributionType;
}) {
  const txns = row.transactions
    .filter((t) => t.type === type && t.supersededAt === null)
    .sort((a, b) => {
      // Null dates last, then chronological ascending.
      if (a.date === null && b.date === null) return 0;
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return a.date.localeCompare(b.date);
    });

  if (txns.length === 0) return null;

  const label = type === "EMPLOYER" ? "Employer" : "Personal";

  return (
    <div className="px-3 py-2 bg-muted/10 border-t border-border">
      <h6 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
        {row.taxYearLabel} · {label} transactions ({txns.length})
      </h6>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-muted-foreground text-left">
            <th className="pb-1 font-normal">Date</th>
            <th className="pb-1 font-normal">Description</th>
            <th className="pb-1 font-normal text-right">Amount</th>
            <th className="pb-1 font-normal text-right">Page</th>
            <th className="pb-1 font-normal">Source</th>
          </tr>
        </thead>
        <tbody>
          {txns.map((t) => (
            <TransactionRow key={t.id} txn={t} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TransactionRow({ txn }: { txn: ContributionTransaction }) {
  const dateDisplay = txn.date ? txn.date.slice(0, 10) : null;
  return (
    <tr className="border-t border-border">
      <td className="py-1">
        {dateDisplay ?? (
          <span className="text-muted-foreground italic">no date</span>
        )}
      </td>
      <td className="py-1">{txn.description}</td>
      <td className="py-1 text-right">
        {formatCurrency(parseFloat(txn.amount))}
      </td>
      <td className="py-1 text-right">{txn.sourcePage ?? "—"}</td>
      <td className="py-1">
        <span
          className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
            txn.source === "AI"
              ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
              : "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300"
          }`}
        >
          {txn.source}
        </span>
      </td>
    </tr>
  );
}
