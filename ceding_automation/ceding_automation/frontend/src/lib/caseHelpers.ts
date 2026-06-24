export interface CaseRow {
  id: string;
  case_ref: string;
  client_name: string;
  Provider_group: string;
  Plan_Number: string;
  provider_phone_main?: string;
  provider_phone_ceding?: string;
  provider_id?: string | null;
  plan_number: string;
  plan_type: string;
  status: string;
  current_stage?: number | null;
  stages_completed?: number[] | null;
  missing_fields_count?: number | null;
  confidence_score?: number | null;
  rag?: string | null;
  owner_name?: string | null;
  owner_id?: string | null;
  paraplanner_id?: string | null;
  paraplanner_name?: string | null;
  current_value?: string | null;
  transfer_value?: string | null;
  case_notes?: string | null;
  last_activity_at?: string | null;
  updated_at?: string | null;
  created_at?: string;
  loa_sent_date?: string | null;
  zoho_task_id?: string | null;
  zoho_ceding_status?: string | null;
  sr_prepared_at?: string | null;
  ceding_complete_date?: string | null;
  [key: string]: unknown;
}

export const CASE_STATUSES = [
  "pending_loa",
  "awaiting_documents",
  "extraction_complete",
  "in_review",
  "approved",
  "complete",
  "on_hold",
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number] | string;

export const STATUS_LABELS: Record<string, string> = {
  pending_loa: "Pending LOA",
  awaiting_documents: "Awaiting Documents",
  extraction_complete: "Extraction Complete",
  in_review: "In Review",
  approved: "Approved",
  complete: "Complete",
  on_hold: "On Hold",
  // legacy
  loa_sent: "LOA Sent",
  loa_processed: "LOA Processed",
  waiting_pdf: "Waiting PDF",
  pdf_received: "PDF Received",
  ceding_in_progress: "Ceding In Progress",
};

export const STATUS_STYLES: Record<string, string> = {
  pending_loa: "bg-info/15 text-info",
  awaiting_documents: "bg-warning/15 text-warning",
  extraction_complete: "bg-primary/15 text-primary",
  in_review: "bg-warning/15 text-warning",
  approved: "bg-success/15 text-success",
  complete: "bg-success/15 text-success",
  on_hold: "bg-overdue/15 text-overdue",
  loa_sent: "bg-info/15 text-info",
  waiting_pdf: "bg-warning/15 text-warning",
  pdf_received: "bg-primary/15 text-primary",
  ceding_in_progress: "bg-primary/15 text-primary",
};

/**
 * Plan-type dropdown options. `value` matches the backend Prisma `PlanType`
 * enum (PENSION / ISA / GIA / …); `label` is the user-facing display string.
 * Form submissions must send `value`, not `label`.
 */
// Phase 1 supports three plan types: Pension, ISA, GIA. "Personal Pension"
// is a *sub-type* (handled separately via PlanSubType), not a plan type.
export const PLAN_TYPES = [
  { label: "Pension", value: "PENSION" },
  { label: "ISA", value: "ISA" },
  { label: "GIA", value: "GIA" },
] as const;

export type PlanType = (typeof PLAN_TYPES)[number]["value"];

export type Rag = "red" | "amber" | "green";

export const RAG_STYLES: Record<Rag, { dot: string; bg: string; text: string; label: string }> = {
  red: { dot: "bg-overdue", bg: "bg-overdue/10", text: "text-overdue", label: "Red" },
  amber: { dot: "bg-warning", bg: "bg-warning/10", text: "text-warning", label: "Amber" },
  green: { dot: "bg-success", bg: "bg-success/10", text: "text-success", label: "Green" },
};

export function calculateRag(c: CaseRow): Rag {
  if (c.status === "complete" || c.status === "approved") return "green";
  if (c.status === "on_hold") return "red";
  const last = new Date(c.last_activity_at ?? c.updated_at ?? c.created_at);
  const days = Math.floor((Date.now() - last.getTime()) / (1000 * 60 * 60 * 24));
  // count working days approx: subtract weekends
  const workingDays = Math.max(0, days - Math.floor(days / 7) * 2);
  if (workingDays >= 5) return "red";
  const missing = c.missing_fields_count ?? 0;
  const conf = c.confidence_score ?? 100;
  if (missing > 0 || conf < 70) return "amber";
  return "green";
}

export const CEDING_STAGES = [
  { num: 1, key: "case_details", label: "Case Details" },
  { num: 2, key: "send_loa", label: "Send LOA" },
  { num: 3, key: "document_upload", label: "Document Upload" },
  { num: 4, key: "ai_extraction", label: "Extract & Fill Gaps" },
  { num: 5, key: "call_assist", label: "Call Assist" },
  { num: 6, key: "review_checklist", label: "Review Checklist" },
  { num: 7, key: "audit_trail", label: "Audit Trail" },
  { num: 8, key: "approval", label: "Approval" },
  { num: 9, key: "export", label: "Export & WorkDrive" },
  { num: 10, key: "complete", label: "Ceding Complete" },
] as const;

export function generateCaseRef(planType: string) {
  const prefix = planType.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 3);
  const num = Math.floor(Math.random() * 90000) + 10000;
  return `FH-${prefix}-${num}`;
}
