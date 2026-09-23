// frontend/src/components/case/FundVerificationPanel.tsx
//
// Stage 6. Checks every holding on the case against the fund master (name,
// charges) and FE Fund Info (unit price), shows the CA both figures side by
// side, and lets them decide which one goes to CRM.
//
// The decision is the point of the screen. Export pushes what is recorded
// here and never looks the figures up again, because the CA signs these off
// at stage 6 and CRM has to carry the numbers somebody actually approved.

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { FundLine, SourceChoice, VerificationSummary } from "@/hooks/useFundLines";
import {
  compareFundLine,
  SOURCE_FIELD_KEY,
  type ComparisonField,
  type FieldComparison,
  type ValueSource,
} from "@/lib/fundComparison";

interface Props {
  rows: FundLine[];
  loading: boolean;
  /** Runs verification for the whole case. */
  onVerify: () => Promise<VerificationSummary>;
  /** Records which figure to carry forward for one field of one holding. */
  onChooseSource: (lineId: string, choice: SourceChoice) => Promise<void>;
  /** CA / admin can act; everyone else sees the result read-only. */
  canEdit: boolean;
  /**
   * Fired when the environment has no fund verification configured at all.
   * Stage 6 lifts its gate on this: a deployment problem must not strand a
   * case, and there is nothing the CA could do about it anyway.
   */
  onUnavailable?: () => void;
}

/** Distinguishes "we could not reach the data" from "it is not set up here". */
type PanelError = { kind: "unavailable" | "unreachable"; message: string } | null;

function statusOf(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

function messageOf(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: string } } })?.response?.data;
  return data?.error ?? fallback;
}

function RagChip({ rag }: { rag: FundLine["holdingRag"] }) {
  if (rag === "AMBER") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-warning/15 text-warning">
        Amber
      </span>
    );
  }
  if (rag === "RED") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-destructive/15 text-destructive">
        Red
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
      Unchecked
    </span>
  );
}

/**
 * Two-option segmented control. Two buttons rather than a dropdown: the whole
 * decision is visible without opening anything, which is what makes a table
 * of these scannable.
 */
function SourceToggle({
  comparison,
  disabled,
  onPick,
}: {
  comparison: FieldComparison;
  disabled: boolean;
  onPick: (choice: ValueSource) => void;
}) {
  const locked = Boolean(comparison.lockedReason);
  const options: Array<{ value: ValueSource; label: string }> = [
    { value: "CEDING", label: "Checklist" },
    { value: "LOOKUP", label: "Reference" },
  ];

  return (
    <div
      className="inline-flex rounded-md border border-border overflow-hidden"
      title={comparison.lockedReason}
    >
      {options.map((o) => {
        const active = comparison.chosen === o.value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled || locked}
            onClick={() => !active && onPick(o.value)}
            className={[
              "px-2 py-0.5 text-[10px] font-semibold transition-colors",
              active
                ? "bg-teal text-white"
                : "bg-background text-muted-foreground hover:bg-muted/60",
              disabled || locked ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function FieldRow({
  comparison,
  disabled,
  onPick,
}: {
  comparison: FieldComparison;
  disabled: boolean;
  onPick: (choice: ValueSource) => void;
}) {
  const differs = comparison.status === "differs";
  return (
    <tr className={differs ? "bg-warning/5" : ""}>
      <td className="px-3 py-1.5 text-muted-foreground w-[150px]">
        <span className="inline-flex items-center gap-1.5">
          {differs && <AlertTriangle className="h-3 w-3 text-warning shrink-0" />}
          {comparison.label}
        </span>
      </td>
      <td
        className={`px-3 py-1.5 ${
          comparison.chosen === "CEDING" ? "font-semibold text-foreground" : "text-muted-foreground"
        }`}
      >
        {comparison.cedingDisplay}
      </td>
      <td
        className={`px-3 py-1.5 ${
          comparison.chosen === "LOOKUP" ? "font-semibold text-foreground" : "text-muted-foreground"
        }`}
      >
        {comparison.lookupDisplay}
      </td>
      <td className="px-3 py-1.5 text-right">
        <SourceToggle comparison={comparison} disabled={disabled} onPick={onPick} />
      </td>
    </tr>
  );
}

export function FundVerificationPanel({
  rows,
  loading,
  onVerify,
  onChooseSource,
  canEdit,
  onUnavailable,
}: Props) {
  const [running, setRunning] = useState(false);
  const [panelError, setPanelError] = useState<PanelError>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // Rows the user has explicitly opened or closed. Anything not in here
  // follows the default: open when it needs a decision.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const comparisons = useMemo(
    () => rows.map((r) => ({ row: r, cmp: compareFundLine(r) })),
    [rows],
  );

  const verifiedCount = comparisons.filter((c) => c.cmp.verified).length;
  const disagreeing = comparisons.filter((c) => c.cmp.hasDisagreement).length;
  const redCount = rows.filter((r) => r.holdingRag === "RED").length;
  const amberCount = rows.filter((r) => r.holdingRag === "AMBER").length;
  const allVerified = rows.length > 0 && verifiedCount === rows.length;

  const lastVerified = useMemo(() => {
    const stamps = rows.map((r) => r.verifiedAt).filter(Boolean) as string[];
    if (stamps.length === 0) return null;
    return new Date(stamps.sort().at(-1) as string);
  }, [rows]);

  const runVerify = async () => {
    setRunning(true);
    setPanelError(null);
    try {
      const summary = await onVerify();
      toast.success(
        `Checked ${summary.checked} of ${summary.total} holding${summary.total === 1 ? "" : "s"}`,
        {
          description:
            summary.red > 0
              ? `${summary.amber} amber · ${summary.red} red — red holdings could not be named or priced.`
              : "Every holding resolved to a fund and a price.",
        },
      );
    } catch (err) {
      const status = statusOf(err);
      if (status === 503) {
        // Not configured on this environment. Not the CA's problem to solve,
        // and not a reason to trap the case at stage 6.
        setPanelError({
          kind: "unavailable",
          message: messageOf(err, "Fund verification is not configured on this environment."),
        });
        onUnavailable?.();
      } else {
        setPanelError({
          kind: "unreachable",
          message: messageOf(
            err,
            "Could not reach the fund data service. Nothing was changed — please try again.",
          ),
        });
      }
    } finally {
      setRunning(false);
    }
  };

  const pick = async (row: FundLine, field: ComparisonField, choice: ValueSource) => {
    const key = `${row.id}:${field}`;
    setSavingKey(key);
    try {
      await onChooseSource(row.id, { [SOURCE_FIELD_KEY[field]]: choice });
    } catch (err) {
      toast.error("Could not record that choice", {
        description: messageOf(err, "Please try again."),
      });
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) {
    return (
      <div className="rounded-md border border-border bg-card px-4 py-6 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading fund verification…
      </div>
    );
  }

  // Nothing to verify. Say so plainly rather than showing an empty control
  // panel that looks like something has gone wrong.
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
          No fund details on this case — nothing to verify.
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground">
            Fund Verification
          </h4>
          {allVerified ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-success">
              <CheckCircle2 className="h-3 w-3" />
              {amberCount} amber · {redCount} red
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-warning">
              <ShieldAlert className="h-3 w-3" />
              {rows.length - verifiedCount} of {rows.length} not yet checked
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {lastVerified && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              Checked {lastVerified.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
            </span>
          )}
          {canEdit && (
            <Button
              size="sm"
              variant={allVerified ? "outline" : "default"}
              onClick={runVerify}
              disabled={running}
              className="h-7 gap-1.5 text-xs"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {running ? "Checking…" : allVerified ? "Re-check" : "Verify fund details"}
            </Button>
          )}
        </div>
      </div>

      {panelError && (
        <div
          className={`px-3 py-2 flex items-start gap-2 text-xs border-b border-border ${
            panelError.kind === "unavailable"
              ? "bg-warning/10 text-foreground"
              : "bg-destructive/10 text-foreground"
          }`}
        >
          <AlertTriangle
            className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${
              panelError.kind === "unavailable" ? "text-warning" : "text-destructive"
            }`}
          />
          <div>
            <p className="font-semibold">{panelError.message}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {panelError.kind === "unavailable"
                ? "You can still send this case on — the checklist figures will be used as they are."
                : "No holding was changed. Try again; if it keeps failing, raise it before sending the case on."}
            </p>
          </div>
        </div>
      )}

      {disagreeing > 0 && (
        <div className="px-3 py-2 flex items-start gap-2 text-xs bg-warning/10 border-b border-border">
          <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
          <p className="text-foreground">
            <strong>
              {disagreeing} holding{disagreeing === 1 ? "" : "s"}
            </strong>{" "}
            disagree with the reference data. Pick which figure goes to CRM on each — the choice
            you make here is what gets exported.
          </p>
        </div>
      )}

      <div className="divide-y divide-border">
        {comparisons.map(({ row, cmp }) => {
          // Rows needing a decision open themselves; the rest stay folded
          // away so a clean case is one line per holding.
          const open = toggled[row.id] ?? cmp.hasDisagreement;
          return (
            <div key={row.id}>
              <button
                type="button"
                onClick={() => setToggled({ ...toggled, [row.id]: !open })}
                className="w-full px-3 py-2 flex items-center gap-2 text-xs text-left hover:bg-muted/20 transition-colors"
              >
                {open ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <RagChip rag={row.holdingRag} />
                <span className="font-medium text-foreground truncate flex-1">{row.fundName}</span>
                <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                  {row.resolvedIsin ?? row.isinSedolCiti ?? "no identifier"}
                </span>
                {cmp.hasDisagreement && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-warning shrink-0">
                    <AlertTriangle className="h-3 w-3" /> Check
                  </span>
                )}
              </button>

              {open && (
                <div className="px-3 pb-3">
                  {!cmp.verified ? (
                    <p className="text-[11px] text-muted-foreground italic px-3 py-2">
                      Not verified yet — run the check above to compare this holding against the
                      fund master and FE Fund Info.
                    </p>
                  ) : (
                    <table className="w-full text-[11px] border border-border rounded-md overflow-hidden">
                      <thead className="bg-muted/20 text-muted-foreground">
                        <tr>
                          <th className="text-left px-3 py-1.5 font-semibold">Field</th>
                          <th className="text-left px-3 py-1.5 font-semibold">
                            Checklist{" "}
                            <span className="font-normal normal-case">(what the CA entered)</span>
                          </th>
                          <th className="text-left px-3 py-1.5 font-semibold">
                            Reference{" "}
                            <span className="font-normal normal-case">(fund master / FE)</span>
                          </th>
                          <th className="text-right px-3 py-1.5 font-semibold">Push to CRM</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {cmp.fields.map((f) => (
                          <FieldRow
                            key={f.field}
                            comparison={f}
                            disabled={!canEdit || savingKey === `${row.id}:${f.field}` || running}
                            onPick={(choice) => void pick(row, f.field, choice)}
                          />
                        ))}
                      </tbody>
                    </table>
                  )}

                  {cmp.verified && row.holdingRag === "RED" && (
                    <p className="text-[11px] text-muted-foreground mt-1.5 px-1">
                      Red: this holding could not be both named and priced from the reference data.
                      Your checklist figures are used as they are — red does not block the case.
                    </p>
                  )}
                  {cmp.verified && row.resolvedPriceDate && (
                    <p className="text-[10px] text-muted-foreground mt-1.5 px-1 tabular-nums">
                      Reference price dated{" "}
                      {new Date(row.resolvedPriceDate).toLocaleDateString("en-GB")}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
