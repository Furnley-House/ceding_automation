// Merge AI-extracted values into existing checklist field rows.
//
// RULES (decided in Phase 3 planning):
//  1. Never overwrite a field a human has manually edited (`manually_edited = true`)
//  2. Never overwrite a field that is `approved` or `review_requested`
//  3. Otherwise, use the AI value if it has any value, OR keep existing if AI value is null

export interface ChecklistRow {
  id: string;
  case_id: string;
  field_key: string;
  label: string;
  section: string;
  value: string | null;
  confidence: string | null;
  status: string;
  source_page?: number | null;
  evidence_source?: string | null;
  evidence_ref?: string | null;
  extracted_at?: string | null;
  manually_edited?: boolean;
  notes?: string | null;
  is_approved?: boolean;
  approved_at?: string | null;
  review_comment?: string | null;
  review_requested_at?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ExtractedField {
  key: string;
  value: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
  source_page?: number | null;
  source_section?: string | null;
  reasoning?: string | null;
}

export interface MergeDecision {
  field_key: string;
  case_id: string;
  label: string;
  section: string;
  value: string | null;
  confidence: string;
  status: string;
  source_page: number | null;
  evidence_source: string | null;
  evidence_ref: string | null;
  extracted_at: string;
  manually_edited: boolean;
  notes?: string | null;
}

interface MergeContext {
  caseId: string;
  documentName: string;
  templateLookup: Map<string, { label: string; section: string }>;
  existingByKey: Map<string, ChecklistRow>;
}

export function mergeExtractedFields(
  extracted: ExtractedField[],
  ctx: MergeContext,
): { upserts: MergeDecision[]; skipped: { key: string; reason: string }[] } {
  const upserts: MergeDecision[] = [];
  const skipped: { key: string; reason: string }[] = [];
  const now = new Date().toISOString();

  for (const f of extracted) {
    const tpl = ctx.templateLookup.get(f.key);
    if (!tpl) {
      skipped.push({ key: f.key, reason: "Unknown field key (not in template)" });
      continue;
    }

    const existing = ctx.existingByKey.get(f.key);

    // Rule 1 + 2: protect human-edited or human-actioned values
    if (existing) {
      if (existing.manually_edited) {
        skipped.push({ key: f.key, reason: "Manually edited — kept" });
        continue;
      }
      if (existing.status === "approved" || existing.status === "review_requested") {
        skipped.push({ key: f.key, reason: `Already ${existing.status} — kept` });
        continue;
      }
    }

    // If AI says missing AND we already have a value, keep existing
    if (f.confidence === "MISSING" && existing?.value) {
      skipped.push({ key: f.key, reason: "AI couldn't find it — kept existing" });
      continue;
    }

    const evidence_ref = f.source_page
      ? `Page ${f.source_page}${f.source_section ? `, ${f.source_section}` : ""}`
      : null;

    upserts.push({
      field_key: f.key,
      case_id: ctx.caseId,
      label: tpl.label,
      section: tpl.section,
      value: f.value,
      confidence: f.confidence,
      status: f.value ? "pending" : "missing",
      source_page: f.source_page ?? null,
      evidence_source: f.value ? ctx.documentName : null,
      evidence_ref,
      extracted_at: now,
      manually_edited: false,
      notes: f.reasoning ?? null,
    });
  }

  return { upserts, skipped };
}
