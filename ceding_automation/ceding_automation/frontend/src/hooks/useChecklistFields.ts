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

export function useChecklistFields({ caseId, template }: UseChecklistArgs) {
  const { role, userName } = useRole();
  const [rows, setRows] = useState<ChecklistRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/cases/${caseId}/checklist`);
      const raw = res.data as { fields?: unknown[]; [k: string]: unknown };
      setRows((snakeKeys(raw.fields ?? raw) as ChecklistRow[]) ?? []);
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
        if (!cancelled) setRows((snakeKeys(raw.fields ?? raw) as ChecklistRow[]) ?? []);
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
        const seeded = (snakeKeys(seedRes.data) as ChecklistRow);
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
