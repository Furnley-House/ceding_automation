/**
 * Service Layer — Express backend implementation
 *
 * Replaces Supabase calls with Express API calls.
 * Keeps the same interface signatures so all frontend code works unchanged.
 */

import { api } from "@/lib/api";

// ── camelCase → snake_case key conversion ─────────────────────────────────
function toSnake(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase();
}

function snakeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(snakeKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [toSnake(k), snakeKeys(val)])
    );
  }
  return v;
}

function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function camelKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [toCamel(k), camelKeys(val)])
    );
  }
  return v;
}

// ── Backend → UI status mapping ───────────────────────────────────────────
const STATUS_MAP: Record<string, string> = {
  DRAFT: "pending_loa",
  STAGE_1_LOA_PREP: "pending_loa",
  STAGE_2_COLLECT_DETAILS: "pending_loa",
  STAGE_3_CRM_SETUP: "pending_loa",
  STAGE_4_PROVIDER_REQUEST: "awaiting_documents",
  STAGE_5_CHASING: "awaiting_documents",
  STAGE_6_DOCUMENT_UPLOAD: "awaiting_documents",
  STAGE_7_MISSING_INFO: "extraction_complete",
  STAGE_8_VERIFY_CHECKLIST: "extraction_complete",
  STAGE_9_ADVISER_REVIEW: "in_review",
  STAGE_10_COMPLETE: "complete",
  ON_HOLD: "on_hold",
  IN_REVIEW: "in_review",
  APPROVED: "approved",
  CANCELLED: "complete",
};

// ── Flatten nested case fields to match UI expectations ──────────────────
function flattenCase(c: Record<string, unknown>): Record<string, unknown> {
  const provider = c.provider as Record<string, unknown> | null | undefined;
  const assignedTo = c.assigned_to as Record<string, unknown> | null | undefined;
  const rawStatus = (c.status as string | undefined) ?? "";
  const uiStatus = STATUS_MAP[rawStatus.toUpperCase()] ?? rawStatus.toLowerCase();
  return {
    ...c,
    backend_status: rawStatus,       // keep original for API calls
    status: uiStatus,
    provider_name: provider?.name ?? "",
    plan_number: c.policy_ref ?? c.policy_reference ?? "",
    assigned_to_name: assignedTo?.name ?? "",
  };
}

// ==================== CASES ====================

export async function getCases() {
  const res = await api.get("/cases", { params: { limit: 200 } });
  // Backend returns { cases: [...], total, page, limit }
  const raw = res.data as { cases?: unknown[]; [k: string]: unknown };
  const arr = raw.cases ?? (Array.isArray(raw) ? raw : []);
  return (snakeKeys(arr) as Record<string, unknown>[]).map(flattenCase);
}

export async function getCaseById(id: string) {
  const res = await api.get(`/cases/${id}`);
  return flattenCase(snakeKeys(res.data) as Record<string, unknown>);
}

export async function getCaseByRef(ref: string) {
  const res = await api.get("/cases", { params: { search: ref, limit: 1 } });
  const raw = res.data as { cases?: unknown[] };
  const arr = (raw.cases ?? []) as Record<string, unknown>[];
  const converted = (snakeKeys(arr) as Record<string, unknown>[]).map(flattenCase);
  return converted[0] ?? null;
}

export async function createCase(caseData: Record<string, unknown>) {
  const res = await api.post("/cases", camelKeys(caseData));
  return snakeKeys(res.data);
}

export async function updateCase(id: string, updates: Record<string, unknown>) {
  const res = await api.patch(`/cases/${id}`, camelKeys(updates));
  return snakeKeys(res.data);
}

// ==================== CHECKLIST ====================

export async function getChecklistFields(caseId: string) {
  const res = await api.get(`/cases/${caseId}/checklist`);
  return snakeKeys(res.data) as unknown[];
}

export async function upsertChecklistFields(fields: Record<string, unknown>[]) {
  if (!fields.length) return [];
  const caseId = fields[0].case_id as string;
  const results = await Promise.all(
    fields.map((f) =>
      api
        .patch(`/cases/${caseId}/checklist/${f.id ?? f.field_key}`, camelKeys(f))
        .then((r) => snakeKeys(r.data))
        .catch(() => f)
    )
  );
  return results;
}

export async function updateChecklistField(id: string, updates: Record<string, unknown>) {
  const caseId = updates.case_id as string;
  const res = await api.patch(`/cases/${caseId}/checklist/${id}`, camelKeys(updates));
  return snakeKeys(res.data);
}

// ==================== DOCUMENTS ====================

export async function getDocuments(caseId?: string) {
  if (!caseId) return [];
  const res = await api.get(`/cases/${caseId}/documents`);
  return snakeKeys(res.data) as unknown[];
}

export async function uploadPolicyDocument(file: File, caseId: string) {
  const form = new FormData();
  form.append("file", file);
  const res = await api.post(`/cases/${caseId}/documents`, form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return snakeKeys(res.data);
}

// ==================== AI EXTRACTION ====================

export async function runAIExtraction(documentId: string, caseId?: string) {
  const url = caseId
    ? `/cases/${caseId}/documents/${documentId}/extract`
    : `/documents/${documentId}/extract`;
  const res = await api.post(url);
  return snakeKeys(res.data);
}

// ==================== PROVIDERS ====================

export async function getProviders() {
  const res = await api.get("/providers");
  return snakeKeys(res.data) as unknown[];
}

// ==================== TASKS ====================
// Not yet implemented in backend — return empty stubs

export async function getTasks(_completed?: boolean) {
  return [] as unknown[];
}

export async function updateTask(_id: string, _updates: Record<string, unknown>) {
  return null;
}

// ==================== AUTOMATION RULES ====================
// Not yet implemented in backend — return empty stubs

export async function getAutomationRules() {
  return [] as unknown[];
}

export async function updateAutomationRule(
  _id: string,
  _updates: Record<string, unknown>
) {
  return null;
}
