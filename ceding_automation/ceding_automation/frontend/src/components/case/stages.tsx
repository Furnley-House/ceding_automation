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
import { useDocuments } from "@/hooks/useDocuments";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useChecklistFields } from "@/hooks/useChecklistFields";
import { getTemplate, groupBySection } from "@/lib/checklistTemplates";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { casesApi } from "@/lib/api";
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
  const { documents, removeDocument, refresh } = useDocuments(caseItem.id);
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
      description="Side-by-side viewer — Gemini reads each PDF, populates the checklist, and links every value to its source page. Fill any remaining gaps inline."
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
  const template = useMemo(() => getTemplate(caseItem.plan_type), [caseItem.plan_type]);
  const { rows, loading } = useChecklistFields({ caseId: caseItem.id, template });

  type ReviewFilter = "all" | "filled" | "missing";
  const [filter, setFilter] = useState<ReviewFilter>("all");

  const totals = useMemo(() => {
    const total = rows.length;
    const filled = rows.filter((r) => r.value && r.value.trim().length > 0).length;
    const missing = total - filled;
    return { total, filled, missing, complete: total > 0 && missing === 0 };
  }, [rows]);

  const grouped = useMemo(() => groupBySection(template), [template]);

  const filteredGrouped = useMemo(() => {
    if (filter === "all") return grouped;
    return grouped
      .map(({ section, fields }) => ({
        section,
        fields: fields.filter((f) => {
          const row = rows.find((r) => r.field_key === f.key);
          const isFilled = !!row?.value && row.value.trim().length > 0;
          return filter === "filled" ? isFilled : !isFilled;
        }),
      }))
      .filter((g) => g.fields.length > 0);
  }, [grouped, rows, filter]);

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!caseItem.owner_id || !caseItem.owner_name) {
        throw new Error(
          "No paraplanner is assigned to this case from CRM. Re-import the task from Zoho CRM with an assignee.",
        );
      }
      await casesApi.updateStatus(caseItem.id, "in_review");
    },
    onSuccess: () => {
      toast.success(`Sent to ${caseItem.owner_name} for approval`);
      qc.invalidateQueries({ queryKey: ["case", caseItem.id] });
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
        {/* Summary tiles */}
        <div className="grid grid-cols-3 gap-3">
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
              {filter === "missing" ? "Every field is filled — nice!" : "Nothing filled yet."}
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
                    const row = rows.find((r) => r.field_key === f.key);
                    const filled = !!row?.value && row.value.trim().length > 0;
                    return (
                      <li key={f.key} className="flex items-start gap-3 px-3 py-2 text-sm">
                        <span className="mt-0.5 shrink-0">
                          {filled ? (
                            <CheckCircle2 className="h-4 w-4 text-success" />
                          ) : (
                            <span className="inline-block h-2 w-2 rounded-full bg-warning" />
                          )}
                        </span>
                        <span className="text-muted-foreground min-w-[180px]">{f.label}</span>
                        <span className={`flex-1 ${filled ? "text-foreground" : "italic text-warning"}`}>
                          {filled ? row!.value : "Missing"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}

        {/* Send for approval */}
        <div className="rounded-md border border-border bg-muted/30 p-4">
          {totals.complete ? (
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-success shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-foreground">Checklist complete</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Send to{" "}
                  <strong className="text-foreground">
                    {caseItem.owner_name ?? "the assigned paraplanner"}
                  </strong>{" "}
                  (assigned via CRM import) for approval.
                </p>
              </div>
              <Button
                onClick={() => sendMutation.mutate()}
                disabled={sendMutation.isPending || !caseItem.owner_id}
                className="gap-2 shrink-0"
              >
                <Send className="h-4 w-4" />
                {sendMutation.isPending ? "Sending…" : "Send for approval"}
              </Button>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-warning mt-1.5 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-foreground">
                  {totals.missing} field{totals.missing === 1 ? "" : "s"} still missing
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Go back to <strong>Extract & Fill Gaps</strong> or <strong>Call Assist</strong> to complete every
                  field. Approval can only be requested once the checklist is fully populated.
                </p>
              </div>
            </div>
          )}
        </div>
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
