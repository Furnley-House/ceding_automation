// frontend/src/components/case/FundVerificationPanel.tsx
//
// Stage 6. Checks every holding on the case against the fund master (name,
// charges) and FE Fund Info (unit price), shows the CA both figures side by
// side, and lets them decide which one goes to CRM.
//
// The decision is the point of the screen. Export pushes what is recorded
// here and never looks the figures up again, because the CA signs these off
// at stage 6 and CRM has to carry the numbers somebody actually approved.

import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { FundLine, SourceChoice, VerificationSummary } from "@/hooks/useFundLines";
import {
  compareFundLine,
  SOURCE_FIELD_KEY,
  EDIT_FIELD_KEY,
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
  /** Corrects a checklist value in place, without leaving stage 6. */
  onEditValue: (lineId: string, patch: Record<string, string | null>) => Promise<void>;
  /** CA / admin can act; everyone else sees the result read-only. */
  canEdit: boolean;
  /**
   * Fired when verification could not be run at all — either the environment
   * has none configured, or the fund data could not be reached.
   *
   * Stage 6 lifts its gate on this. Neither is something the CA can fix, and
   * an FE Fund Info outage that froze every case at stage 6 would be a worse
   * failure than the one the gate prevents. The export still stops and asks
   * before anything reaches CRM, so this only relaxes the hand-off.
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

/**
 * The checklist column, click-to-edit.
 *
 * Same interaction as the Fund Details grid on stage 4 — click, type, Enter
 * saves and Escape cancels — because a CA who spots a mistyped price while
 * reviewing should not have to go back two stages to fix it.
 *
 * Only the checklist side is editable. The reference column is what the fund
 * master and FE returned; editing that would be inventing data.
 */
function CedingCell({
  comparison,
  editable,
  saving,
  onSave,
}: {
  comparison: FieldComparison;
  editable: boolean;
  saving: boolean;
  onSave: (raw: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const committing = useRef(false);

  const start = () => {
    if (!editable || saving) return;
    setValue(comparison.cedingRaw ?? "");
    setEditing(true);
  };

  const commit = async () => {
    if (committing.current) return;
    if (value === (comparison.cedingRaw ?? "")) {
      setEditing(false);
      return;
    }
    committing.current = true;
    try {
      await onSave(value);
      setEditing(false);
    } finally {
      committing.current = false;
    }
  };

  if (editing) {
    return (
      <Input
        autoFocus
        type={comparison.field === "fundName" ? "text" : "number"}
        step={comparison.field === "fundName" ? undefined : "0.0001"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        disabled={saving}
        className="h-6 text-[11px] py-0"
      />
    );
  }

  if (!editable) return <span>{comparison.cedingDisplay}</span>;

  // An explicit Edit link, not just a clickable cell. The checklist fields
  // above this panel show one, and a hover-only affordance is invisible to
  // anyone who does not already know it is there.
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={start}
        title="Click to edit"
        className="min-h-[20px] flex items-center text-left cursor-text hover:bg-muted/50 rounded px-1 -mx-1 transition-colors"
      >
        {comparison.cedingDisplay}
      </button>
      <button
        type="button"
        onClick={start}
        className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-teal hover:underline shrink-0"
      >
        <Pencil className="h-2.5 w-2.5" />
        Edit
      </button>
    </span>
  );
}

function FieldRow({
  comparison,
  disabled,
  canEdit,
  saving,
  onPick,
  onSave,
}: {
  comparison: FieldComparison;
  disabled: boolean;
  canEdit: boolean;
  saving: boolean;
  onPick: (choice: ValueSource) => void;
  onSave: (raw: string) => Promise<void>;
}) {
  const differs = comparison.status === "differs";
  return (
    <tr className={differs ? "bg-warning/5" : ""}>
      <td className="px-3 py-1.5 text-muted-foreground w-[150px] align-top">
        <span className="inline-flex items-center gap-1.5">
          {differs && <AlertTriangle className="h-3 w-3 text-warning shrink-0" />}
          {comparison.label}
        </span>
        {/* A 100x gap is almost always pence-vs-pounds, not a wrong figure.
            Saying so turns "2.33 against 233.46" into a decision the CA can
            make in a second. */}
        {comparison.note && (
          <p className="text-[10px] text-muted-foreground italic mt-0.5 leading-snug">
            {comparison.note}
          </p>
        )}
      </td>
      <td
        className={`px-3 py-1.5 ${
          comparison.chosen === "CEDING" ? "font-semibold text-foreground" : "text-muted-foreground"
        }`}
      >
        <CedingCell
          comparison={comparison}
          editable={canEdit}
          saving={saving}
          onSave={onSave}
        />
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
  onEditValue,
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
        // The CA has tried and the data is not reachable. Holding the case at
        // stage 6 indefinitely helps nobody; the export gate still stops the
        // figures reaching CRM without a recorded decision.
        onUnavailable?.();
      }
    } finally {
      setRunning(false);
    }
  };

  const edit = async (row: FundLine, field: ComparisonField, raw: string) => {
    const key = `${row.id}:${field}`;
    setSavingKey(key);
    try {
      // Empty clears the field rather than storing "", so the comparison sees
      // "the CA has no figure" instead of a blank string.
      const trimmed = raw.trim();
      await onEditValue(row.id, { [EDIT_FIELD_KEY[field]]: trimmed === "" ? null : trimmed });
      toast.success("Saved");
    } catch (err) {
      toast.error("Could not save that change", {
        description: messageOf(err, "Please try again."),
      });
    } finally {
      setSavingKey(null);
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
                : "Nothing was changed. Try again in a few minutes; if it keeps failing you can still send the case on, and the export will ask you to confirm before anything reaches CRM."}
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
            {disagreeing === 1 ? "disagrees" : "disagree"} with the reference data. Pick which
            figure goes to CRM on each — the choice you make here is what gets exported.
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
                            canEdit={canEdit}
                            saving={savingKey === `${row.id}:${f.field}`}
                            onPick={(choice) => void pick(row, f.field, choice)}
                            onSave={(raw) => edit(row, f.field, raw)}
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
