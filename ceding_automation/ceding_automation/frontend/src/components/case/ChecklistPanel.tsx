import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, CircleDashed, ListChecks, ThumbsUp } from "lucide-react";
import { ChecklistField, type ChecklistFieldState, type Confidence } from "./ChecklistField";
import { getTemplate, groupBySection, type ChecklistFieldDef } from "@/lib/checklistTemplates";
import { useRole } from "@/hooks/useRole";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useChecklistFields, type ChecklistRow } from "@/hooks/useChecklistFields";

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

  type FieldFilter = "all" | "high" | "review" | "missing" | "approved";
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
    if (filter === "review") return conf === "MEDIUM" || conf === "LOW";
    if (filter === "missing") return conf === "MISSING";
    if (filter === "approved") return r?.status === "approved";
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

  const stats = useMemo(() => {
    const counts = { high: 0, medium: 0, low: 0, missing: 0, approved: 0, review: 0 };
    visibleFields.forEach((f) => {
      const r = byKey.get(f.key);
      const conf = (r?.confidence ?? "MISSING").toUpperCase();
      if (conf === "HIGH") counts.high++;
      else if (conf === "MEDIUM") counts.medium++;
      else if (conf === "LOW") counts.low++;
      else counts.missing++;
      if (r?.status === "approved") counts.approved++;
      if (r?.status === "review_requested") counts.review++;
    });
    const total = visibleFields.length;
    const completion = total === 0 ? 0 : Math.round(((total - counts.missing) / total) * 100);
    return { ...counts, total, completion };
  }, [visibleFields, byKey]);

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
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
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
          <SummaryChip
            icon={ThumbsUp}
            count={stats.approved}
            label="Approved"
            colour="teal"
            active={filter === "approved"}
            onClick={() => setFilter(filter === "approved" ? "all" : "approved")}
          />
        </div>
        {filter !== "all" && (
          <div className="mt-3 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              Showing only <strong className="text-foreground">{filter === "review" ? "needs review" : filter}</strong> fields
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
                  />
                );
              })}
            </div>
          </div>
          ))
        )}
      </div>

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
  colour,
  active,
  onClick,
}: {
  icon: React.ElementType;
  count: number;
  label: string;
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
      </div>
    </button>
  );
}
