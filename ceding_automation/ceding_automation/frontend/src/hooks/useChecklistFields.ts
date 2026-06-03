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
  return {
    ...r,
    source_page: sourcePage,
    evidence_source: r.evidence_source ?? sourceDocName,
    evidence_ref: r.evidence_ref ?? ref,
    notes,
    status,
  };
}
function normaliseRows(raw: unknown): ChecklistRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => adoptEvidenceFields(snakeKeys(r) as ChecklistRow));
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
