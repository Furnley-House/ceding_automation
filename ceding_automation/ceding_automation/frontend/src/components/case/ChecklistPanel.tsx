import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, CircleDashed, ListChecks, ThumbsUp, Ban, LayoutGrid, Table2, Undo2, Redo2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChecklistField, type ChecklistFieldState, type Confidence, type ConflictResolution } from "./ChecklistField";
import { ChecklistTemplateView } from "./ChecklistTemplateView";
import { getTemplate, groupBySection, type ChecklistFieldDef } from "@/lib/checklistTemplates";
import { useRole } from "@/hooks/useRole";
import { useEditHistory } from "@/hooks/useEditHistory";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useChecklistFields, isMissing, fundDetailsStatus, type ChecklistRow } from "@/hooks/useChecklistFields";
import { useDocuments } from "@/hooks/useDocuments";
import { useFundLines } from "@/hooks/useFundLines";
import { checklistApi } from "@/lib/api";
import { FundDetailsTable } from "./FundDetailsTable";
import { ContributionsTable } from "./ContributionsTable";

// Legacy free-text fields that the AI extractor populates with unstructured
// contributions text ("See contributions tables for full history"). These
// are still saved to ChecklistField as a raw fallback, but the checklist UI
// hides them — the new <ContributionsTable> owns the visible representation.
// Pension-only; other plan types don't have these fields in their template.
const CONTRIBUTIONS_LEGACY_FIELD_KEYS = new Set([
  "contributions_4yr_history",
  "contributions_breakdown_employer_personal",
]);

// localStorage key holding the CA's preferred Stage 4 layout. Per-user
// (not per-case) so switching between cases keeps the CA's chosen view.
const VIEW_MODE_STORAGE_KEY = "ceding.stage4.viewMode";
type ViewMode = "table" | "template";
function readInitialViewMode(): ViewMode {
  try {
    const v = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return v === "template" ? "template" : "table";
  } catch {
    return "table";
  }
}

// Section name (from checklist-fields-v1.json) that contains the Fund
// Details block. The template view renders the FundDetailsTable inline
// beneath this section's scalar rows.
const FUND_SECTION_NAME = "Valuation & Fund Details";

interface Props {
  planType: string;
  caseId: string;
  /** When provided, fields render a 📄 button that calls back with source info.
   *  sourceDocumentId is the authoritative resolver — the workspace switches
   *  to that doc before scrolling. evidenceSource (filename) is kept as a
   *  fallback for legacy rows where the id is null. sourceQuote is the AI's
   *  verbatim excerpt — PdfViewer uses it to highlight the exact span on
   *  the jumped-to page (null skips highlight, page-jump still happens). */
  onJumpToSource?: (
    sourcePage: number | null,
    fieldLabel: string,
    evidenceSource: string | null,
    sourceDocumentId: string | null,
    sourceQuote: string | null,
  ) => void;
  /** Id of the document currently shown in the PDF viewer. Used to compute
   *  the per-field "from X.pdf" indicator — when a field's source doc differs
   *  from this id, the ChecklistField surfaces a switch hint. Omit when the
   *  panel is rendered outside the side-by-side workspace (Stage 6/8). */
  currentDocumentId?: string | null;
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
export function ChecklistPanel({ planType, caseId, onJumpToSource, currentDocumentId, refreshSignal }: Props) {
  const template = useMemo(() => getTemplate(planType), [planType]);
  const { canEditChecklist, canApprove, isAdviser } = useRole();
  const { rows, byKey, loading, refresh, updateField, approveAllFilled } = useChecklistFields({
    caseId,
    template,
  });

  // Layout toggle — persisted per user, not per case. Users get the same
  // view when switching between cases in one session.
  const [viewMode, setViewModeState] = useState<ViewMode>(readInitialViewMode);
  const setViewMode = useCallback((v: ViewMode) => {
    setViewModeState(v);
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, v);
    } catch {
      /* private-mode Safari, etc. — ignore */
    }
  }, []);

  // Undo/redo for FIELD VALUE edits only. Status flips (Approve, Request
  // review), the Mark-N-missing-as-N/A batch, and evidence-link edits are
  // NOT tracked — the user asked for value-only scope. History is session-
  // scoped (in-memory) and clears on refresh or case switch.
  const applyValueForUndo = useCallback(
    async (fieldKey: string, value: string | null) => {
      // Bypasses handleFieldChange so undo/redo doesn't record itself as
      // a new edit and create an infinite loop.
      await updateField(fieldKey, { value }, { action: "undo_redo", notes: undefined });
    },
    [updateField],
  );
  const history = useEditHistory({ applyValue: applyValueForUndo });
  // Reset history when the case changes — a stack from case A that names
  // fields on case B would be nonsensical (fields may not even exist).
  useEffect(() => {
    history.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  // Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) — global while the panel is mounted.
  // Skipped when focus is in an input/textarea so the browser's native
  // in-input undo continues to work while typing.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
      const isMeta = e.ctrlKey || e.metaKey;
      if (!isMeta) return;
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        history.undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        history.redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [history]);
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

  // Set of live doc ids — used to detect "source deleted": a field with a
  // source_document_id that no longer matches any document in the case (the
  // source PDF was removed after extraction). The persistent
  // source_document_name snapshot is what we then show to the user.
  const liveDocumentIds = useMemo(() => {
    const s = new Set<string>();
    documents.forEach((d) => { if (d.id) s.add(d.id); });
    return s;
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

  // Pension-only: the structured <ContributionsTable> replaces two free-text
  // fields on the checklist UI. On non-Pension plans, those fields aren't
  // in the template anyway — the Set filter is a no-op there.
  const isPension = useMemo(() => {
    const n = (planType ?? "").toLowerCase();
    return n === "pension" || n.startsWith("pension");
  }, [planType]);

  const visibleFields = useMemo(
    () =>
      template.filter((f) => {
        // Hide legacy contributions text fields on Pension (structured
        // ContributionsTable owns the visible representation now).
        if (isPension && CONTRIBUTIONS_LEGACY_FIELD_KEYS.has(f.key)) return false;
        if (!f.showIf) return true;
        const dependent = byKey.get(f.showIf.key)?.value;
        return dependent ? f.showIf.in.includes(dependent) : false;
      }),
    [template, byKey, isPension],
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

    // Capture prev value BEFORE the update so undo can restore it. Only
    // value changes are tracked — status/confidence/comment flips are
    // intentionally out of scope per the product decision.
    const prevValue =
      patch.value !== undefined ? byKey.get(f.key)?.value ?? null : null;

    await updateField(f.key, dbPatch, { action, notes: patch.comment ?? undefined });

    if (patch.value !== undefined) {
      history.record({
        fieldKey: f.key,
        fieldLabel: f.label,
        prev: prevValue,
        next: patch.value ?? null,
      });
    }
  };

  const approveAll = async () => {
    await approveAllFilled();
    toast.success("All filled fields approved", {
      description: "Missing fields skipped — please send those back to CA Team if needed.",
    });
  };

  // ── Bulk-mark all missing checklist fields as "N/A" ────────────────────
  // Real workflow, not a test helper: some providers legitimately don't
  // return every field, and typing N/A into each one is slow. Fund Details
  // is left alone (separate table with its own edit UX). Server enforces
  // CA_TEAM / ADMIN role and won't clobber existing values or approved
  // fields, so the confirmation prompt is UX-only.
  const qcMark = useQueryClient();
  const markMissingNA = useMutation({
    mutationFn: async () => {
      const res = await checklistApi.markMissingNA(caseId);
      return res.data as { filled: number; message: string };
    },
    onSuccess: (d) => {
      toast.success(d.message ?? "Marked missing fields as N/A");
      refresh();
      qcMark.invalidateQueries({ queryKey: ["case", caseId] });
    },
    onError: (e: Error) =>
      toast.error("Mark-as-N/A failed", { description: e.message }),
  });

  const confirmAndMarkNA = () => {
    if (stats.missing === 0) return;
    const ok = window.confirm(
      `Mark ${stats.missing} missing field${stats.missing === 1 ? "" : "s"} as "N/A"?\n\n` +
        "Approved fields and fields with existing values are untouched. " +
        "You can still edit individual fields afterwards.",
    );
    if (ok) markMissingNA.mutate();
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
      {/* ── Toolbar: undo / redo + layout toggle ───────────────────────────
         Sits above the plan-type card so undo/redo are visible from any
         scroll position on the right panel. Undo/redo cover field VALUE
         edits only; the layout toggle swaps between the default card grid
         and the Excel-template-styled row layout. */}
      <div className="flex items-center justify-between rounded-md border border-border bg-card px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => history.undo()}
            disabled={!history.canUndo}
            className="h-8 gap-1.5"
            title="Undo last field-value edit (Ctrl+Z)"
          >
            <Undo2 className="h-3.5 w-3.5" />
            Undo
            {history.undoCount > 0 && (
              <span className="text-[10px] text-muted-foreground ml-0.5">
                {history.undoCount}
              </span>
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => history.redo()}
            disabled={!history.canRedo}
            className="h-8 gap-1.5"
            title="Redo last undone edit (Ctrl+Shift+Z)"
          >
            <Redo2 className="h-3.5 w-3.5" />
            Redo
            {history.redoCount > 0 && (
              <span className="text-[10px] text-muted-foreground ml-0.5">
                {history.redoCount}
              </span>
            )}
          </Button>
        </div>
        <div
          role="tablist"
          aria-label="Checklist layout"
          className="flex items-center gap-0.5 rounded border border-border bg-muted/40 p-0.5"
        >
          <button
            role="tab"
            aria-selected={viewMode === "table"}
            onClick={() => setViewMode("table")}
            className={`px-2 py-1 text-xs rounded flex items-center gap-1 transition-colors ${
              viewMode === "table"
                ? "bg-card shadow-sm text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Card grid (default)"
          >
            <LayoutGrid className="h-3.5 w-3.5" /> Table
          </button>
          <button
            role="tab"
            aria-selected={viewMode === "template"}
            onClick={() => setViewMode("template")}
            className={`px-2 py-1 text-xs rounded flex items-center gap-1 transition-colors ${
              viewMode === "template"
                ? "bg-card shadow-sm text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Excel-template-styled rows"
          >
            <Table2 className="h-3.5 w-3.5" /> Template
          </button>
        </div>
      </div>

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
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={confirmAndMarkNA}
              disabled={markMissingNA.isPending || stats.missing === 0}
              className="gap-1"
              title="Set every currently-missing field to N/A. Approved fields and fields with real values are left alone."
            >
              <Ban className="h-3.5 w-3.5" />
              {markMissingNA.isPending
                ? "Marking…"
                : `Mark ${stats.missing} missing as N/A`}
            </Button>
            <Button size="sm" onClick={markReadyForReview} disabled={stats.missing > 0} className="gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> Mark Ready for Review
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {filteredGrouped.length === 0 && filter !== "all" ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 p-8 text-center">
            <p className="text-sm font-medium text-foreground">No fields match this filter</p>
            <p className="text-xs text-muted-foreground mt-1">Try a different filter or clear it to see everything.</p>
          </div>
        ) : viewMode === "template" ? (
          // Template view renders scalar fields as Excel-template-styled
          // rows (label in col A, wide answer cell in cols B..G) and
          // inlines the FundDetailsTable inside the Valuation section.
          <ChecklistTemplateView
            grouped={filteredGrouped}
            byKey={byKey}
            fundSectionName={FUND_SECTION_NAME}
            readOnly={!canEditChecklist}
            onFieldChange={handleFieldChange}
            onJumpToSource={onJumpToSource}
            caseId={caseId}
            extraContentBySection={
              isPension
                ? {
                    "Transaction History": (
                      <ContributionsTable
                        caseId={caseId}
                        readOnly={!canEditChecklist}
                      />
                    ),
                  }
                : undefined
            }
          />
        ) : (
          filteredGrouped.map(({ section, fields }) => (
          <div key={section} className="rounded-md border border-border bg-card">
            <div className="px-4 py-2 border-b border-border bg-muted/30">
              <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground">
                {section}
              </h4>
            </div>
            {/* Pension Contributions table renders at the top of the
               Transaction History section — it replaces the two legacy
               text fields that were filtered out of visibleFields above. */}
            {isPension && section === "Transaction History" && (
              <div className="p-3 border-b border-border">
                <ContributionsTable caseId={caseId} readOnly={!canEditChecklist} />
              </div>
            )}
            <div className="p-3 grid gap-2 md:grid-cols-2">
              {fields.map((f) => {
                const r = byKey.get(f.key);
                // Resolve the per-field source doc state for Part C's
                // indicator and to feed Part A's id-based jump.
                //   - sourceDocId  : authoritative FK (may be null on legacy)
                //   - sourceDocName: persistent snapshot (outlives deletion)
                //   - deleted      : id present but doc not in the live list
                //   - different    : id resolves to a doc OTHER than the open one
                const sourceDocId = r?.source_document_id ?? null;
                const sourceDocName = r?.source_document_name ?? null;
                const isSourceDeleted =
                  !!sourceDocId && !liveDocumentIds.has(sourceDocId);
                const isFromDifferentDoc =
                  !!sourceDocId &&
                  !isSourceDeleted &&
                  !!currentDocumentId &&
                  sourceDocId !== currentDocumentId;
                return (
                  <ChecklistField
                    key={f.key}
                    def={f}
                    state={stateForField(f)}
                    onChange={(patch) => handleFieldChange(f, patch)}
                    onJumpToSource={
                      onJumpToSource && r?.source_page
                        ? () =>
                            onJumpToSource(
                              r.source_page ?? null,
                              f.label,
                              r.evidence_source ?? null,
                              sourceDocId,
                              r.source_quote ?? null,
                            )
                        : undefined
                    }
                    sourceDocumentName={sourceDocName}
                    isFromDifferentDoc={isFromDifferentDoc}
                    isSourceDeleted={isSourceDeleted}
                    conflict={buildConflict(f)}
                  />
                );
              })}
            </div>
          </div>
          ))
        )}
      </div>

      {/* Fund Details — sub-table. In table view it renders as a separate
          section beneath the field grid. In template view it's inlined
          inside the Valuation & Fund Details section by ChecklistTemplateView,
          so we skip the standalone render to avoid duplication. */}
      {viewMode !== "template" && (
        <FundDetailsTable caseId={caseId} readOnly={!canEditChecklist} />
      )}

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
