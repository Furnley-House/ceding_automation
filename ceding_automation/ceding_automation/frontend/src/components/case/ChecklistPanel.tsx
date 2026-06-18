import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, CircleDashed, ListChecks, ThumbsUp } from "lucide-react";
import { ChecklistField, type ChecklistFieldState, type Confidence, type ConflictResolution } from "./ChecklistField";
import { getTemplate, groupBySection, type ChecklistFieldDef } from "@/lib/checklistTemplates";
import { useRole } from "@/hooks/useRole";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useChecklistFields, isMissing, fundDetailsStatus, type ChecklistRow } from "@/hooks/useChecklistFields";
import { useDocuments } from "@/hooks/useDocuments";
import { useFundLines } from "@/hooks/useFundLines";
import { checklistApi } from "@/lib/api";
import { FundDetailsTable } from "./FundDetailsTable";

interface Props {
  planType: string;
  caseId: string;
  /** When provided, fields render a 📄 button that calls back with source info */
  onJumpToSource?: (sourcePage: number | null, fieldLabel: string, evidenceSource: string | null) => void;
  /**
   * Bumped by an external signal (e.g. AI extraction completing) to force a
   * checklist refetch without remounting the panel. Increment any number
   * (1, 2, 3, …) to trigger one refresh.
   */
  refreshSignal?: number;
}

/**
 * DB-backed checklist. Reads from `checklist_fields`, seeds from the plan-type
 * template on first open, persists every edit and writes audit-log entries.
 */
export function ChecklistPanel({ planType, caseId, onJumpToSource, refreshSignal }: Props) {
  const template = useMemo(() => getTemplate(planType), [planType]);
  const { canEditChecklist, canApprove, isAdviser } = useRole();
  const { rows, byKey, loading, refresh, updateField, approveAllFilled } = useChecklistFields({
    caseId,
    template,
  });
  // Used to resolve conflict_values.new_document_id → human document name.
  // The case page already mounts this hook elsewhere; React-Query-style
  // dedup isn't in use here, so this triggers one extra GET /documents on
  // initial panel mount. Cheap and lazy — only the document list, not
  // contents.
  const { documents } = useDocuments(caseId);
  const documentNamesById = useMemo(() => {
    const m = new Map<string, string>();
    documents.forEach((d) => {
      if (!d.id) return;
      m.set(d.id, d.original_name ?? d.filename ?? d.id);
    });
    return m;
  }, [documents]);

  // Re-fetch when an external signal arrives (e.g. BFF extraction completed).
  // Skip the first run so we don't double up with useChecklistFields' own
  // mount-time load.
  const firstSignalRef = useRef(true);
  useEffect(() => {
    if (firstSignalRef.current) {
      firstSignalRef.current = false;
      return;
    }
    refresh();
  }, [refreshSignal, refresh]);

  // Stage 4 is the AI extraction review surface. We deliberately omit the
  // "approved" filter here — approval happens later (Stage 6 / Stage 8) and
  // showing it on Stage 4 was just clutter that pushed the useful filters
  // (High / Needs review / Missing) into a tighter row.
  type FieldFilter = "all" | "high" | "review" | "missing";
  const [filter, setFilter] = useState<FieldFilter>("all");

  const visibleFields = useMemo(
    () =>
      template.filter((f) => {
        if (!f.showIf) return true;
        const dependent = byKey.get(f.showIf.key)?.value;
        return dependent ? f.showIf.in.includes(dependent) : false;
      }),
    [template, byKey],
  );

  const grouped = useMemo(() => groupBySection(visibleFields), [visibleFields]);

  const matchesFilter = (key: string) => {
    if (filter === "all") return true;
    const r = byKey.get(key);
    const conf = (r?.confidence ?? "MISSING").toUpperCase();
    if (filter === "high") return conf === "HIGH";
    // CONFLICT belongs in the review bucket — two sources disagreed, the
    // user needs to pick the right value.
    if (filter === "review") return conf === "MEDIUM" || conf === "LOW" || conf === "CONFLICT";
    // Use the shared isMissing helper so confidence=MISSING AND
    // value="MISSING" (literal string from the AI) both count.
    if (filter === "missing") return isMissing(r);
    return true;
  };

  const filteredGrouped = useMemo(
    () =>
      grouped
        .map((g) => ({ ...g, fields: g.fields.filter((f) => matchesFilter(f.key)) }))
        .filter((g) => g.fields.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grouped, filter, byKey],
  );

  // Fund Details is a separate sub-table — pull its rows so we can fold its
  // status into the Missing / Needs Review chips alongside the scalar fields.
  // Without this, a case with zero fund lines reads "All filled" which is
  // misleading.
  const { rows: fundLines } = useFundLines(caseId);
  const fundStatus = useMemo(() => fundDetailsStatus(fundLines), [fundLines]);

  const stats = useMemo(() => {
    const counts = { high: 0, medium: 0, low: 0, conflict: 0, missing: 0, approved: 0, review: 0 };
    visibleFields.forEach((f) => {
      const r = byKey.get(f.key);
      // Missing wins over confidence buckets — a value-says-"MISSING" row
      // would otherwise be counted under HIGH (which it technically came
      // back as) and skew the completion progress bar.
      if (isMissing(r)) {
        counts.missing++;
      } else {
        const conf = (r?.confidence ?? "").toUpperCase();
        if (conf === "HIGH") counts.high++;
        else if (conf === "MEDIUM") counts.medium++;
        // CONFLICT folds into counts.low (same review bucket, needs human
        // decision before approval) AND is tracked separately in
        // counts.conflict so the "Needs review" chip can surface conflict
        // size as a sub-line.
        else if (conf === "LOW" || conf === "CONFLICT") {
          counts.low++;
          if (conf === "CONFLICT") counts.conflict++;
        }
      }
      if (r?.status === "approved") counts.approved++;
      if (r?.status === "review_requested") counts.review++;
    });
    // Fold Fund Details into the buckets as a single logical section.
    if (fundStatus === "missing") counts.missing++;
    else if (fundStatus === "review") counts.low++;
    else if (fundStatus === "filled") counts.high++;
    const total = visibleFields.length + 1; // +1 for the Fund Details section
    const completion = total === 0 ? 0 : Math.round(((total - counts.missing) / total) * 100);
    return { ...counts, total, completion };
  }, [visibleFields, byKey, fundStatus]);

  // Assemble the two-candidate resolver pack for a CONFLICT field. Returns
  // undefined when not conflicted or when the row lacks conflict_values
  // (defensive — shouldn't happen, but the resolver UI would have nothing
  // to show). Closes over caseId + refresh so ChecklistField stays pure.
  const buildConflict = (f: ChecklistFieldDef): ConflictResolution | undefined => {
    const r = byKey.get(f.key) as
      | (ChecklistRow & {
          conflict_values?: {
            existing?: string | null;
            new?: string | null;
            new_document_id?: string | null;
            new_page?: number | null;
          } | null;
          source_document?: { original_name?: string | null; filename?: string | null } | null;
          source_page_number?: number | null;
        })
      | undefined;
    if (!r) return undefined;
    if ((r.confidence ?? "").toUpperCase() !== "CONFLICT") return undefined;
    const cv = r.conflict_values;
    if (!cv) return undefined;
    const newDocId = cv.new_document_id ?? null;
    const incomingDocName = newDocId ? documentNamesById.get(newDocId) ?? null : null;
    const existingDocName =
      r.source_document?.original_name ?? r.source_document?.filename ?? null;
    const existingPage = r.source_page_number ?? r.source_page ?? null;
    return {
      existing: {
        value: r.value ?? null,
        docName: existingDocName,
        page: existingPage,
      },
      incoming: {
        value: cv.new ?? null,
        docName: incomingDocName,
        page: cv.new_page ?? null,
      },
      onResolve: async (chosenValue: string) => {
        try {
          await checklistApi.resolveConflict(caseId, r.id, chosenValue);
          await refresh();
          toast.success("Conflict resolved", { description: `Set to "${chosenValue}"` });
        } catch (err) {
          console.error("resolveConflict failed", err);
          toast.error("Could not resolve conflict — try again");
        }
      },
    };
  };

  const stateForField = (f: ChecklistFieldDef): ChecklistFieldState => {
    const r = byKey.get(f.key);
    if (!r) {
      return { key: f.key, value: null, confidence: "MISSING", status: "missing" };
    }
    return {
      key: f.key,
      value: r.value,
      confidence: ((r.confidence ?? "MISSING").toUpperCase() as Confidence),
      status: (r.status as ChecklistFieldState["status"]) ?? (r.value ? "pending" : "missing"),
      evidenceSource: r.evidence_source
        ? `${r.evidence_source}${r.evidence_ref ? ` · ${r.evidence_ref}` : ""}`
        : r.evidence_ref ?? null,
      evidenceRef: r.evidence_ref,
      manuallyEditedBy: r.manually_edited ? "Manual edit" : null,
      originalAiValue: null,
      comment: r.notes,
    };
  };

  const handleFieldChange = async (
    f: ChecklistFieldDef,
    patch: Partial<ChecklistFieldState>,
  ) => {
    const dbPatch: Partial<ChecklistRow> = {};
    if (patch.value !== undefined) dbPatch.value = patch.value;
    if (patch.confidence !== undefined) dbPatch.confidence = patch.confidence;
    if (patch.status !== undefined) dbPatch.status = patch.status;
    if (patch.comment !== undefined) dbPatch.notes = patch.comment;
    let action = "manual_edit";
    if (patch.status === "approved") action = "approve";
    else if (patch.status === "review_requested") action = "request_review";
    else if (patch.comment !== undefined && patch.value === undefined) action = "comment";
    await updateField(f.key, dbPatch, { action, notes: patch.comment ?? undefined });
  };

  const approveAll = async () => {
    await approveAllFilled();
    toast.success("All filled fields approved", {
      description: "Missing fields skipped — please send those back to CA Team if needed.",
    });
  };

  const markReadyForReview = () => {
    if (stats.missing > 0) {
      toast.error("Cannot mark Ready for Review", {
        description: `${stats.missing} field${stats.missing === 1 ? "" : "s"} still missing.`,
      });
      return;
    }
    toast.success("Case marked Ready for Review", {
      description: "Move to Step 8 to assign a paraplanner.",
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-muted/30 p-4">
        <div className="flex items-center justify-between gap-4 mb-3">
          <h3 className="text-sm font-bold theme-heading text-foreground flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-teal" />
            {planType} checklist · {stats.total} fields
          </h3>
          <span className="text-xs font-semibold text-foreground">{stats.completion}% complete</span>
        </div>
        <div className="h-1.5 bg-background rounded overflow-hidden mb-3">
          <div className="h-full bg-teal transition-all" style={{ width: `${stats.completion}%` }} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <SummaryChip
            icon={CheckCircle2}
            count={stats.high}
            label="High confidence"
            colour="success"
            active={filter === "high"}
            onClick={() => setFilter(filter === "high" ? "all" : "high")}
          />
          <SummaryChip
            icon={AlertTriangle}
            count={stats.medium + stats.low}
            label="Needs review"
            subLabel={
              stats.conflict > 0
                ? `incl. ${stats.conflict} conflict${stats.conflict === 1 ? "" : "s"}`
                : undefined
            }
            colour="warning"
            active={filter === "review"}
            onClick={() => setFilter(filter === "review" ? "all" : "review")}
          />
          <SummaryChip
            icon={CircleDashed}
            count={stats.missing}
            label="Missing"
            colour="overdue"
            active={filter === "missing"}
            onClick={() => setFilter(filter === "missing" ? "all" : "missing")}
          />
        </div>
        {filter !== "all" && (
          <div className="mt-3 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {filter === "review" ? (
                <>
                  Showing fields that need review (<strong className="text-foreground">medium, low confidence, or conflicting sources</strong>)
                </>
              ) : (
                <>
                  Showing only <strong className="text-foreground">{filter}</strong> fields
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => setFilter("all")}
              className="text-teal hover:underline font-semibold"
            >
              Clear filter
            </button>
          </div>
        )}
      </div>

      {canApprove && (
        <div className="flex items-center justify-between rounded-md border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">
            <strong className="text-foreground">{isAdviser ? "Adviser" : "Paraplanner"} review:</strong> approve each field, request review, or add comments.
          </p>
          <Button variant="outline" size="sm" onClick={approveAll} className="gap-1">
            <ThumbsUp className="h-3.5 w-3.5" /> Approve all filled
          </Button>
        </div>
      )}

      {canEditChecklist && !canApprove && (
        <div className="flex items-center justify-between rounded-md border border-border bg-card p-3">
          <p className="text-xs text-muted-foreground">
            <strong className="text-foreground">CA Team:</strong> edit any field — changes auto-save and are audit-logged.
          </p>
          <Button size="sm" onClick={markReadyForReview} disabled={stats.missing > 0} className="gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" /> Mark Ready for Review
          </Button>
        </div>
      )}

      <div className="space-y-4">
        {filteredGrouped.length === 0 && filter !== "all" ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 p-8 text-center">
            <p className="text-sm font-medium text-foreground">No fields match this filter</p>
            <p className="text-xs text-muted-foreground mt-1">Try a different filter or clear it to see everything.</p>
          </div>
        ) : (
          filteredGrouped.map(({ section, fields }) => (
          <div key={section} className="rounded-md border border-border bg-card">
            <div className="px-4 py-2 border-b border-border bg-muted/30">
              <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground">
                {section}
              </h4>
            </div>
            <div className="p-3 grid gap-2 md:grid-cols-2">
              {fields.map((f) => {
                const r = byKey.get(f.key);
                return (
                  <ChecklistField
                    key={f.key}
                    def={f}
                    state={stateForField(f)}
                    onChange={(patch) => handleFieldChange(f, patch)}
                    onJumpToSource={
                      onJumpToSource && r?.source_page
                        ? () => onJumpToSource(r.source_page ?? null, f.label, r.evidence_source ?? null)
                        : undefined
                    }
                    conflict={buildConflict(f)}
                  />
                );
              })}
            </div>
          </div>
          ))
        )}
      </div>

      {/* Fund Details — sub-table. Filter ignores scalar-field filters above
          since this section doesn't share their state (High/Missing/etc.). */}
      <FundDetailsTable caseId={caseId} readOnly={!canEditChecklist} />

      {loading && (
        <p className="text-[10px] text-muted-foreground text-center pt-2">Loading checklist…</p>
      )}
    </div>
  );
}

function SummaryChip({
  icon: Icon,
  count,
  label,
  subLabel,
  colour,
  active,
  onClick,
}: {
  icon: React.ElementType;
  count: number;
  label: string;
  /** Optional secondary line under the label (e.g. "incl. 2 conflicts"). */
  subLabel?: string;
  colour: "success" | "warning" | "overdue" | "teal";
  active?: boolean;
  onClick?: () => void;
}) {
  const styles: Record<string, string> = {
    success: "bg-success/10 text-success border-success/30",
    warning: "bg-warning/10 text-warning border-warning/30",
    overdue: "bg-overdue/10 text-overdue border-overdue/30",
    teal: "bg-teal/10 text-teal border-teal/30",
  };
  const ringStyles: Record<string, string> = {
    success: "ring-2 ring-success/60",
    warning: "ring-2 ring-warning/60",
    overdue: "ring-2 ring-overdue/60",
    teal: "ring-2 ring-teal/60",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-2 px-2.5 py-1.5 rounded border text-left transition-all hover:shadow-sm ${styles[colour]} ${active ? ringStyles[colour] : "opacity-90 hover:opacity-100"}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <div className="leading-tight">
        <p className="font-bold text-sm text-foreground">{count}</p>
        <p className="text-[10px] text-muted-foreground">{label}</p>
        {subLabel && (
          <p className="text-[9px] text-muted-foreground opacity-80">{subLabel}</p>
        )}
      </div>
    </button>
  );
}
