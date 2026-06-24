import type { CaseRow } from "@/lib/caseHelpers";
import {
  FileText,
  Upload,
  Cpu,
  Phone,
  History,
  ClipboardCheck,
  Send,
  CheckCircle2,
  Download,
  Sparkles,
  MessageSquare,
  AlertTriangle,
} from "lucide-react";
import { Mail } from "lucide-react";
import { SendLOAWorkspace } from "./SendLOAWorkspace";
import { DocumentUploader } from "./DocumentUploader";
import { DocumentList } from "./DocumentList";
import { ExtractionWorkspace } from "./ExtractionWorkspace";
import { CallWorkspace } from "./CallWorkspace";
import { AuditTimeline } from "./AuditTimeline";
import { ApprovalWorkspace } from "./ApprovalWorkspace";
import { ExportWorkspace } from "./ExportWorkspace";
import { CompleteWorkspace } from "./CompleteWorkspace";
import { FundDetailsTable } from "./FundDetailsTable";
import { useDocuments } from "@/hooks/useDocuments";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useChecklistFields, isMissing, displayValue, fundDetailsStatus } from "@/hooks/useChecklistFields";
import { useFundLines } from "@/hooks/useFundLines";
import { getTemplate, groupBySection } from "@/lib/checklistTemplates";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation } from "react-router-dom";
import { casesApi, checklistApi } from "@/lib/api";
import { useRole } from "@/hooks/useRole";
import { Pencil, FlaskConical } from "lucide-react";
import { toast } from "sonner";
interface StageProps {
  caseItem: CaseRow;
}

const TOTAL_STAGES = 10;

function StagePanel({
  num,
  icon: Icon,
  title,
  description,
  children,
  comingSoon,
}: {
  num: number;
  icon: React.ElementType;
  title: string;
  description: string;
  children?: React.ReactNode;
  comingSoon?: string;
}) {
  return (
    <div className="theme-card theme-card-accent border border-border bg-card">
      <div className="flex items-start gap-3 mb-4 pb-4 border-b border-border">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-teal/15 text-teal shrink-0">
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <p className="text-[10px] uppercase tracking-widest text-teal font-semibold">Step {num} of {TOTAL_STAGES}</p>
          <h2 className="text-lg font-bold theme-heading text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
        </div>
      </div>
      {children}
      {comingSoon && (
        <div className="mt-4 rounded-md border border-dashed border-border bg-muted/30 p-4 text-center">
          <Sparkles className="h-5 w-5 mx-auto text-teal mb-2" />
          <p className="text-xs font-semibold text-foreground">{comingSoon}</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            This stage will be fully built out in the next phase. Use the buttons below to navigate.
          </p>
        </div>
      )}
    </div>
  );
}

export function StageCaseDetails({ caseItem }: StageProps) {
  return (
    <StagePanel
      num={1}
      icon={FileText}
      title="Case Details"
      description="Confirm the case metadata captured from Zoho CRM or entered manually."
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Detail label="Client name" value={caseItem.client_name} />
        <Detail label="Provider" value={caseItem.Provider_group} />
        <Detail label="Plan type" value={caseItem.plan_type} />
        <Detail label="Policy reference" value={caseItem.plan_number} mono />
        <Detail label="Zoho CRM task" value={(caseItem as any).zoho_task_id ?? "—"} mono />
        <Detail label="Assigned CA" value={caseItem.owner_name ?? "—"} />
        <Detail
          label="LOA status"
          value={
            caseItem.loa_sent_date
              ? `Sent ${new Date(caseItem.loa_sent_date).toLocaleDateString("en-GB")}`
              : "Not sent"
          }
        />
        <Detail
          label="Send method"
          value="Email"
          hint="Will pull from Provider Directory in Phase 8"
        />
      </dl>
      {caseItem.case_notes && (
        <div className="mt-4 rounded-md bg-muted/40 border border-border p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Case notes</p>
          <p className="text-sm text-foreground whitespace-pre-wrap">{caseItem.case_notes}</p>
        </div>
      )}
    </StagePanel>
  );
}

export function StageSendLOA({ caseItem }: StageProps) {
  return (
    <StagePanel
      num={2}
      icon={Mail}
      title="Send LOA"
      description="Send the Letter of Authority via Origo, email or courier — and track the response back from the provider."
    >
      <SendLOAWorkspace caseItem={caseItem} />
    </StagePanel>
  );
}

export function StageDocumentUpload({ caseItem }: StageProps) {
  // (Stage 3 — see StageSendLOA above for stage 2)
  const { documents, removeDocument, refresh } = useDocuments(caseItem.id, { refreshInterval: 5000 });
  return (
    <StagePanel
      num={3}
      icon={Upload}
      title="Document Upload"
      description="Upload the policy pack(s) received from the provider — PDF, Word, Excel, or plain text. Multi-file supported."
    >
      <div className="space-y-4">
        <DocumentUploader caseId={caseItem.id} onUploaded={refresh} />
        <div className="rounded-md border border-border bg-card p-3">
          <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground mb-2">
            Uploaded documents ({documents.length})
          </h4>
          <DocumentList
            documents={documents}
            caseId={caseItem.id}
            planType={caseItem.plan_type}
            selectedId={null}
            onSelect={() => {}}
            onRemove={removeDocument}
            showExtractButton={false}
            showViewButton={false}
            simplifiedBadge
          />
        </div>
      </div>
    </StagePanel>
  );
}

export function StageAIExtraction({ caseItem }: StageProps) {
  return (
    <StagePanel
      num={4}
      icon={Cpu}
      title="Extract & Fill Gaps"
      description=""
    >
      <ExtractionWorkspace caseId={caseItem.id} planType={caseItem.plan_type} />
    </StagePanel>
  );
}

export function StageCallAssist({ caseItem }: StageProps) {
  return (
    <StagePanel
      num={5}
      icon={Phone}
      title="Call Assist with AI Script"
      description="AI generates a tailored script targeting your remaining missing fields. Start the call (RingCentral in production), capture the transcript, then merge the agent's answers straight into the checklist."
    >
      <CallWorkspace
        caseId={caseItem.id}
        planType={caseItem.plan_type}
        clientName={caseItem.client_name}
        providerName={caseItem.Provider_group}
        planNumber={caseItem.plan_number}
        providerPhoneMain={caseItem.provider_phone_main}
        providerPhoneCeding={caseItem.provider_phone_ceding}
      />
    </StagePanel>
  );
}

export function StageReviewChecklist({ caseItem }: StageProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { isCA, isAdmin } = useRole();
  const template = useMemo(() => getTemplate(caseItem.plan_type), [caseItem.plan_type]);
  const { rows, loading, refresh, updateField } = useChecklistFields({ caseId: caseItem.id, template });

  type ReviewFilter = "all" | "filled" | "missing" | "returned";
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const goToStage = (n: number) => {
    navigate(location.pathname, { state: { goToStage: n }, replace: false });
  };

  const fillTestData = useMutation({
    mutationFn: async () => {
      const res = await checklistApi.fillTestData(caseItem.id);
      return res.data as { filled: number; message: string };
    },
    onSuccess: (d) => {
      toast.success(d.message ?? "Filled missing fields with test data");
      refresh();
      qc.invalidateQueries({ queryKey: ["case", caseItem.id] });
    },
    onError: (e: Error) => toast.error("Test-fill failed", { description: e.message }),
  });

  const openEditor = (key: string, currentValue: string | null | undefined) => {
    setEditingKey(key);
    setEditValue(currentValue ?? "");
  };
  const saveEditor = async () => {
    if (!editingKey) return;
    const v = editValue.trim();
    await updateField(editingKey, { value: v || null });
    toast.success("Field saved");
    setEditingKey(null);
    setEditValue("");
  };

  const byKey = useMemo(() => {
    const m = new Map<string, (typeof rows)[number]>();
    rows.forEach((r) => { if (r.field_key) m.set(r.field_key, r); });
    return m;
  }, [rows]);

  // Mirror ChecklistPanel: only count template fields whose showIf condition
  // is satisfied. Counting raw DB rows pulls in stale/legacy fields and gives
  // a different total than Extract & Fill Gaps and the Excel export.
  const visibleFields = useMemo(
    () =>
      template.filter((f) => {
        if (!f.showIf) return true;
        const dependent = byKey.get(f.showIf.key)?.value;
        return dependent ? f.showIf.in.includes(dependent) : false;
      }),
    [template, byKey],
  );

  // Fund Details rolls into the totals alongside the scalar fields so the
  // chip counters agree with Stage 4 and so an empty Fund Details table
  // doesn't read as "All filled".
  const { rows: fundLines } = useFundLines(caseItem.id);
  const fundStatus = useMemo(() => fundDetailsStatus(fundLines), [fundLines]);

  const totals = useMemo(() => {
    const fieldTotal = visibleFields.length;
    let filled = 0;
    let returned = 0;
    visibleFields.forEach((f) => {
      const r = byKey.get(f.key);
      if (!isMissing(r)) filled += 1;
      if (r?.status === "review_requested") returned += 1;
    });
    // +1 row for Fund Details. Filled when fundStatus is "filled" OR "review"
    // (the section has data, just not all high-confidence); missing only when
    // there are no rows / every row is empty.
    const fundFilled = fundStatus !== "missing";
    const total = fieldTotal + 1;
    if (fundFilled) filled += 1;
    const missing = total - filled;
    return {
      total,
      filled,
      missing,
      returned,
      complete: total > 0 && missing === 0 && returned === 0,
    };
  }, [visibleFields, byKey, fundStatus]);

  const grouped = useMemo(() => groupBySection(visibleFields), [visibleFields]);

  const filteredGrouped = useMemo(() => {
    if (filter === "all") return grouped;
    return grouped
      .map(({ section, fields }) => ({
        section,
        fields: fields.filter((f) => {
          const r = byKey.get(f.key);
          const missing = isMissing(r);
          if (filter === "filled") return !missing;
          if (filter === "missing") return missing;
          if (filter === "returned") return r?.status === "review_requested";
          return true;
        }),
      }))
      .filter((g) => g.fields.length > 0);
  }, [grouped, byKey, filter]);

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await casesApi.updateStatus(caseItem.id, "in_review");
      return res.data as { paralPlannerId?: string | null };
    },
    onSuccess: () => {
      const paraplannerName = caseItem.paraplanner_name ?? "the paraplanner";
      toast.success(`Sent to ${paraplannerName} for approval`);
      qc.invalidateQueries({ queryKey: ["case", caseItem.id] });
      qc.invalidateQueries({ queryKey: ["cases"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <StagePanel
      num={6}
      icon={ClipboardCheck}
      title="Review Checklist"
      description="Final review of the completed checklist before handing off for paraplanner approval."
    >
      <div className="space-y-4">
        {/* CA quick actions */}
        {(isCA || isAdmin) && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2.5">
            <span className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground pr-1">
              CA actions
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => goToStage(4)}
              className="h-7 gap-1.5 text-xs"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit fields (Stage 4)
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => goToStage(5)}
              className="h-7 gap-1.5 text-xs"
            >
              <Phone className="h-3.5 w-3.5" /> Call provider (Stage 5)
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fillTestData.mutate()}
              disabled={fillTestData.isPending || totals.missing === 0}
              className="h-7 gap-1.5 text-xs ml-auto"
              title="Testing only: bulk-fill any missing field with type-aware dummy data"
            >
              <FlaskConical className="h-3.5 w-3.5" />
              {fillTestData.isPending ? "Filling…" : `Fill ${totals.missing} missing (test)`}
            </Button>
          </div>
        )}

        {/* Returned-for-re-review banner */}
        {totals.returned > 0 && (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-foreground">
                {totals.returned} field{totals.returned === 1 ? "" : "s"} returned by{" "}
                {caseItem.paraplanner_name ?? "paraplanner"} for re-review
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Read the comment on each flagged field, correct the value (or do a follow-up call
                on Stage 5 Call Assist), then re-send for approval.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setFilter("returned")}
              className="text-xs font-semibold text-warning hover:underline shrink-0"
            >
              Show flagged →
            </button>
          </div>
        )}

        {/* Summary tiles */}
        <div className="grid grid-cols-4 gap-3">
          <SummaryTile
            label="Total fields"
            value={totals.total}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          <SummaryTile
            label="Filled"
            value={totals.filled}
            tone="success"
            active={filter === "filled"}
            onClick={() => setFilter(filter === "filled" ? "all" : "filled")}
          />
          <SummaryTile
            label="Missing"
            value={totals.missing}
            tone={totals.missing > 0 ? "warning" : "muted"}
            active={filter === "missing"}
            onClick={() => setFilter(filter === "missing" ? "all" : "missing")}
          />
          <SummaryTile
            label="Returned"
            value={totals.returned}
            tone={totals.returned > 0 ? "warning" : "muted"}
            active={filter === "returned"}
            onClick={() => setFilter(filter === "returned" ? "all" : "returned")}
          />
        </div>
        {filter !== "all" && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              Showing only <strong className="text-foreground">{filter}</strong> fields
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

        {/* Sections */}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading checklist…</p>
        ) : filteredGrouped.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 p-8 text-center">
            <p className="text-sm font-medium text-foreground">No fields match this filter</p>
            <p className="text-xs text-muted-foreground mt-1">
              {filter === "missing"
                ? "Every field is filled — nice!"
                : filter === "returned"
                ? "Nothing has been sent back for re-review."
                : "Nothing filled yet."}
            </p>
          </div>
        ) : (
          <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1 scrollbar-thin">
            {filteredGrouped.map(({ section, fields }) => (
              <div key={section} className="rounded-md border border-border bg-card">
                <div className="px-3 py-2 border-b border-border bg-muted/30">
                  <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground">{section}</h4>
                </div>
                <ul className="divide-y divide-border">
                  {fields.map((f) => {
                    const row = byKey.get(f.key);
                    const missing = isMissing(row);
                    const filled = !missing;
                    const returned = row?.status === "review_requested";
                    const editable = (isCA || isAdmin) && (returned || missing);
                    return (
                      <li
                        key={f.key}
                        className={`flex flex-col gap-1 px-3 py-2 text-sm ${returned ? "bg-warning/5" : ""}`}
                      >
                        <div className="flex items-start gap-3">
                          <span className="mt-0.5 shrink-0">
                            {returned ? (
                              <AlertTriangle className="h-4 w-4 text-warning" />
                            ) : filled ? (
                              <CheckCircle2 className="h-4 w-4 text-success" />
                            ) : (
                              <span className="inline-block h-2 w-2 rounded-full bg-warning" />
                            )}
                          </span>
                          <span className="text-muted-foreground min-w-[180px]">{f.label}</span>
                          <span className={`flex-1 ${filled ? "text-foreground" : "italic text-warning"}`}>
                            {filled ? displayValue(row) : "Missing"}
                          </span>
                          {editable && (
                            <button
                              type="button"
                              onClick={() => openEditor(f.key, row?.value)}
                              className="text-[11px] text-teal hover:underline font-semibold shrink-0"
                            >
                              Edit
                            </button>
                          )}
                        </div>
                        {returned && row?.notes && (
                          <div className="ml-7 flex items-start gap-1 text-[11px] text-foreground bg-muted/50 px-2 py-1 rounded">
                            <MessageSquare className="h-3 w-3 mt-0.5 shrink-0 text-warning" />
                            <span className="italic">{row.notes}</span>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}

        {/* Fund Details sub-table — read-only at Stage 6.
            CA can still edit it back on Stage 4 if anything needs a tweak. */}
        <FundDetailsTable caseId={caseItem.id} readOnly />

        {/* Send for approval — always visible, button enabled even when
            incomplete so CA can hand off mid-flight (paraplanner will see
            the gaps and either ask the CA to fill them or send them back). */}
        <div className="rounded-md border border-border bg-muted/30 p-4">
          <div className="flex items-start gap-3">
            {totals.complete ? (
              <CheckCircle2 className="h-5 w-5 text-success shrink-0 mt-0.5" />
            ) : (
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-warning mt-1.5 shrink-0" />
            )}
            <div className="flex-1">
              <p className="text-sm font-semibold text-foreground">
                {totals.complete
                  ? "Checklist complete"
                  : (() => {
                      const parts: string[] = [];
                      if (totals.missing > 0)
                        parts.push(`${totals.missing} field${totals.missing === 1 ? "" : "s"} still missing`);
                      if (totals.returned > 0)
                        parts.push(`${totals.returned} returned for re-review`);
                      return parts.join(" · ");
                    })()}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {totals.complete ? (
                  <>
                    Send to{" "}
                    <strong className="text-foreground">
                      {caseItem.paraplanner_name ?? "the assigned paraplanner"}
                    </strong>{" "}
                    for approval.
                  </>
                ) : (
                  <>
                    You can still send to{" "}
                    <strong className="text-foreground">
                      {caseItem.paraplanner_name ?? "the assigned paraplanner"}
                    </strong>{" "}
                    — they'll see the gaps and can send fields back via Stage 8. Ideally
                    fill the missing ones in <strong>Extract & Fill Gaps</strong> or{" "}
                    <strong>Call Assist</strong> first.
                  </>
                )}
              </p>
            </div>
            <Button
              onClick={() => sendMutation.mutate()}
              disabled={sendMutation.isPending}
              variant={totals.complete ? "default" : "outline"}
              className="gap-2 shrink-0"
            >
              <Send className="h-4 w-4" />
              {sendMutation.isPending
                ? "Sending…"
                : totals.complete
                ? "Send for approval"
                : "Send anyway"}
            </Button>
          </div>
        </div>

        {/* Inline edit dialog for returned / missing fields */}
        {editingKey && (
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
            onClick={() => setEditingKey(null)}
          >
            <div
              className="bg-card border border-border rounded-lg shadow-lg w-[420px] max-w-[90vw] p-4 space-y-3"
              onClick={(e) => e.stopPropagation()}
            >
              <div>
                <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                  {template.find((t) => t.key === editingKey)?.section ?? ""}
                </p>
                <h3 className="text-sm font-bold text-foreground">
                  {template.find((t) => t.key === editingKey)?.label ?? editingKey}
                </h3>
              </div>
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                rows={3}
                autoFocus
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-mono"
                placeholder="Enter value…"
              />
              {byKey.get(editingKey)?.notes && (
                <div className="flex items-start gap-1 text-[11px] text-foreground bg-muted/50 px-2 py-1 rounded">
                  <MessageSquare className="h-3 w-3 mt-0.5 shrink-0 text-warning" />
                  <span className="italic">
                    Paraplanner note: {byKey.get(editingKey)?.notes}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditingKey(null)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveEditor}>
                  Save
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </StagePanel>
  );
}

function SummaryTile({
  label,
  value,
  tone = "muted",
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone?: "muted" | "success" | "warning";
  active?: boolean;
  onClick?: () => void;
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
      ? "text-warning"
      : "text-foreground";
  const ringClass = active
    ? tone === "success"
      ? "ring-2 ring-success/60"
      : tone === "warning"
      ? "ring-2 ring-warning/60"
      : "ring-2 ring-teal/60"
    : "hover:border-teal/40";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border border-border bg-card p-3 text-center transition-all hover:shadow-sm ${ringClass}`}
    >
      <p className={`text-2xl font-bold theme-heading ${toneClass}`}>{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mt-0.5">{label}</p>
    </button>
  );
}

export function StageAuditTrail({ caseItem }: StageProps) {
  return (
    <StagePanel
      num={7}
      icon={History}
      title="Audit Trail"
      description="Every field change on this case — AI extractions, manual edits, call merges, approvals — captured immutably."
    >
      <AuditTimeline caseId={caseItem.id} />
    </StagePanel>
  );
}

export function StageApproval({ caseItem }: StageProps) {
  return (
    <StagePanel
      num={8}
      icon={CheckCircle2}
      title="Paraplanner / Adviser Approval"
      description="Per-field approve, request review with comment, then sign off the whole case once every field is approved."
    >
      <ApprovalWorkspace caseItem={caseItem} />
    </StagePanel>
  );
}

export function StageExport({ caseItem }: StageProps) {
  return (
    <StagePanel
      num={9}
      icon={Download}
      title="Export & Upload to WorkDrive"
      description="Generate the completed checklist as Excel (Summary + Checklist + Audit Trail tabs) and push to Zoho WorkDrive."
    >
      <ExportWorkspace caseItem={caseItem} />
    </StagePanel>
  );
}

export function StageComplete({ caseItem }: StageProps) {
  return (
    <StagePanel
      num={10}
      icon={CheckCircle2}
      title="Ceding Complete"
      description="All ceding steps are done — the case is ready for the adviser to take over for the Suitability Report."
    >
      <CompleteWorkspace caseItem={caseItem} />
    </StagePanel>
  );
}

function Detail({ label, value, mono, hint }: { label: string; value: string; mono?: boolean; hint?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</dt>
      <dd className={`text-foreground ${mono ? "font-mono text-xs" : "text-sm"}`}>{value}</dd>
      {hint && <p className="text-[10px] text-muted-foreground italic mt-0.5">{hint}</p>}
    </div>
  );
}
