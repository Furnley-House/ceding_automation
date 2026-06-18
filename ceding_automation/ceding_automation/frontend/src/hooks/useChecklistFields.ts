import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { ChecklistRow } from "@/lib/checklistMerge";
import type { ChecklistFieldDef } from "@/lib/checklistTemplates";
import { useRole } from "@/hooks/useRole";

export type { ChecklistRow };

interface UseChecklistArgs {
  caseId: string;
  template: ChecklistFieldDef[];
}

function toSnake(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase();
}
function snakeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(snakeKeys);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [toSnake(k), snakeKeys(val)])
    );
  return v;
}
function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
function camelKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [toCamel(k), camelKeys(val)])
    );
  return v;
}

// The backend serialises the Prisma model fields directly: it emits
// `sourcePageNumber`, `sourceQuote`, `sourceSection`, and `sourceDocument`
// (with `originalName`). After snakeKeys those land as `source_page_number`,
// `source_quote`, `source_section`, `source_document.original_name` — but
// the rest of the UI was written against an older shape that expected
// `source_page`, `evidence_source`, `evidence_ref`. This adapter bridges
// the two so the "Source" jump-to-page button on each checklist field
// actually has the data it needs.
function adoptEvidenceFields(row: ChecklistRow): ChecklistRow {
  const r = row as ChecklistRow & {
    source_page_number?: number | null;
    source_section?: string | null;
    source_quote?: string | null;
    source_document?: { original_name?: string | null; filename?: string | null } | null;
  };
  const sourcePage = r.source_page ?? r.source_page_number ?? null;
  const sourceDocName =
    r.source_document?.original_name ?? r.source_document?.filename ?? null;
  // Compose a human-readable reference for the tooltip — "Page 3, Cash Value"
  // when both are present, just "Page 3" otherwise. Fall back to the raw
  // quote if no page exists.
  const ref = sourcePage
    ? `Page ${sourcePage}${r.source_section ? `, ${r.source_section}` : ""}`
    : r.source_section ?? r.source_quote ?? null;
  // The paraplanner's "Request review" comment is persisted on
  // ChecklistField.reviewComment (→ snake-keyed to `review_comment`). The
  // rest of the UI was written to read `notes` for any field-level comment,
  // so surface review_comment there when no manual note is present.
  const notes = r.notes ?? (r as ChecklistRow & { review_comment?: string | null }).review_comment ?? null;
  // Backend FieldStatus enum is uppercase (APPROVED, REVIEW_REQUESTED, …)
  // but the entire UI compares against lowercase ("approved", …). snakeKeys
  // only renames keys, not values — so without this every approval looked
  // like it had no effect.
  const status = typeof r.status === "string" ? r.status.toLowerCase() : r.status;
  // The Prisma column is `isManuallyOverridden` (boolean) plus
  // `manualEditedById` / `manualEditedAt`. After snakeKeys the wire keys
  // are `is_manually_overridden` / `manual_edited_at`. The frontend was
  // written against `manually_edited` — 4 different consumers (Approval
  // badge, Extract audit-line, Stage 9 XLSX "Manually edited" column,
  // checklistMerge.ts conflict rule) all read that key and so all silently
  // saw `false` for every manual override. Alias here once.
  const rExt = r as ChecklistRow & {
    is_manually_overridden?: boolean | null;
    manual_edited_at?: string | null;
    manual_edited_by_id?: string | null;
    status?: string | null;
  };
  const explicitFlag =
    (rExt as { manually_edited?: boolean | null }).manually_edited ??
    rExt.is_manually_overridden ??
    null;
  const manuallyEdited =
    explicitFlag !== null
      ? explicitFlag
      : !!rExt.manual_edited_at || rExt.status === "manually_overridden";
  return {
    ...r,
    source_page: sourcePage,
    evidence_source: r.evidence_source ?? sourceDocName,
    evidence_ref: r.evidence_ref ?? ref,
    notes,
    status,
    manually_edited: !!manuallyEdited,
  };
}
function normaliseRows(raw: unknown): ChecklistRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => adoptEvidenceFields(snakeKeys(r) as ChecklistRow))
    // Drop the vestigial `fund_lines` ChecklistField row. The backend seed
    // creates one row per template — including the type="table" `fund_lines`
    // template — but the real fund data lives in the ChecklistFundLine
    // relation. The placeholder row only confused things: Stage 5 Call
    // Assist counted it as a missing scalar field (asking the agent "what's
    // the fund_lines value?"), and it inflated Missing counts by 1 vs
    // Stage 4 / 6 which read the frontend template (table types stripped).
    // Filter it out here so every consumer sees the same row set.
    .filter((r) => {
      const fk = (r as { field_key?: string }).field_key;
      const ft = (r as { field_type?: string }).field_type;
      if (fk === "fund_lines") return false;
      if (typeof ft === "string" && ft.toLowerCase() === "table") return false;
      return true;
    });
}

// ── isMissing ───────────────────────────────────────────────────
// A field counts as "missing" when ANY of the following is true:
//   1. The value column is empty (null / undefined / whitespace).
//   2. Confidence is the MISSING enum value (no extraction signal).
//   3. The literal value is the string "MISSING" (case-insensitive) —
//      the AI returns this when the document itself prints "MISSING"
//      in the form field, which is still missing data, not a real value.
//
// Use this everywhere instead of ad-hoc checks like `!row.value`. Keeping
// the rule in one place prevents Stage 4 / Stage 6 / Stage 8 from
// disagreeing about whether the same field is filled.
export function isMissing(row: {
  value?: string | null;
  confidence?: string | null;
} | null | undefined): boolean {
  if (!row) return true;
  const v = (row.value ?? "").trim();
  if (v === "") return true;
  if (v.toUpperCase() === "MISSING") return true;
  const conf = (row.confidence ?? "").toString().toUpperCase();
  if (conf === "MISSING") return true;
  return false;
}

// Display helper — "—" for missing, the actual value otherwise.
// Avoids showing the literal word "MISSING" in tables / approval lists.
export function displayValue(row: {
  value?: string | null;
  confidence?: string | null;
} | null | undefined): string {
  if (isMissing(row)) return "—";
  return (row?.value ?? "").trim();
}

// Fund Details status — the table-typed `fund_lines` field doesn't live on
// ChecklistField (the placeholder row is filtered out above). The real
// per-fund data is in the ChecklistFundLine relation. This helper rolls a
// list of fund rows up into a single status token so the Missing / Needs
// Review counters on Stage 4 / 5 / 6 can include "Fund Details" as a
// logical section, the way the user expects.
//
//   missing — no rows, or every row has an empty value
//   review  — at least one row has empty value OR confidence LOW/MEDIUM/CONFLICT/MISSING
//   filled  — every row has a value AND no row is below HIGH confidence
export type FundDetailsStatus = "missing" | "review" | "filled";
export interface FundLineLike {
  value?: string | null;
  confidence?: string | null;
}
export function fundDetailsStatus(rows: FundLineLike[] | null | undefined): FundDetailsStatus {
  if (!rows || rows.length === 0) return "missing";
  const anyMissing = rows.some(isMissing);
  if (anyMissing && rows.every(isMissing)) return "missing";
  const anyBelowHigh = rows.some((r) => {
    if (isMissing(r)) return true;
    const c = (r.confidence ?? "").toString().toUpperCase();
    return c === "MEDIUM" || c === "LOW" || c === "CONFLICT" || c === "MISSING";
  });
  return anyBelowHigh ? "review" : "filled";
}

export function useChecklistFields({ caseId, template }: UseChecklistArgs) {
  const { role, userName } = useRole();
  const [rows, setRows] = useState<ChecklistRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/cases/${caseId}/checklist`);
      const raw = res.data as { fields?: unknown[]; [k: string]: unknown };
      setRows(normaliseRows(raw.fields ?? raw));
    } catch (err) {
      console.error("useChecklistFields refresh error", err);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  // Initial load — fetch only. Fields are created by AI extraction or manual CA entry,
  // never pre-seeded as empty rows (AI layer is managed separately on Azure).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await api.get(`/cases/${caseId}/checklist`);
        const raw = res.data as { fields?: unknown[]; [k: string]: unknown };
        if (!cancelled) setRows(normaliseRows(raw.fields ?? raw));
      } catch (err) {
        console.error("useChecklistFields load error", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [caseId]);

  const byKey = useMemo(() => {
    const m = new Map<string, ChecklistRow>();
    rows.forEach((r) => { if (r.field_key) m.set(r.field_key, r); });
    return m;
  }, [rows]);

  const updateField = async (
    fieldKey: string,
    patch: Partial<ChecklistRow>,
    _audit?: { action: string; notes?: string | null }
  ) => {
    let existing = byKey.get(fieldKey);
    try {
      if (!existing) {
        // No DB row yet — create one on first manual edit by seeding this single field.
        // Look up label/section from the template prop if available.
        const tpl = template.find((t) => t.key === fieldKey);
        const seedRes = await api.post(`/cases/${caseId}/checklist/seed`, camelKeys({
          field_key: fieldKey,
          label: tpl?.label ?? fieldKey,
          section: tpl?.section ?? "General",
          value: null,
          status: "missing",
        }));
        // Seed returns the created/found row
        const seeded = adoptEvidenceFields(snakeKeys(seedRes.data) as ChecklistRow);
        existing = seeded;
        setRows((prev) => {
          const without = prev.filter((r) => r.field_key !== fieldKey);
          return [...without, seeded];
        });
      }
      await api.patch(
        `/cases/${caseId}/checklist/${existing.id}`,
        camelKeys({ ...patch, isManuallyEdited: patch.value !== existing.value ? true : undefined })
      );
    } catch (err) {
      console.error("updateField error", err);
    }
    refresh();
  };

  const approveAllFilled = async () => {
    const filled = rows.filter(
      (r) => r.value && r.status !== "approved" && r.status !== "review_requested"
    );
    if (!filled.length) return;
    try {
      // Use approve-all endpoint
      await api.post(`/cases/${caseId}/checklist/approve-all`, {
        actorName: userName ?? undefined,
        actorRole: role ?? undefined,
      });
    } catch (err) {
      console.error("approveAllFilled error", err);
    }
    refresh();
  };

  return { rows, byKey, loading, refresh, updateField, approveAllFilled };
}
