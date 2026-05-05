import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { Tables } from "@/integrations/supabase/types";
import type { ChecklistFieldDef } from "@/lib/checklistTemplates";
import { useRole } from "@/hooks/useRole";

export type ChecklistRow = Tables<"checklist_fields">;

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
      setRows((snakeKeys(res.data) as ChecklistRow[]) ?? []);
    } catch (err) {
      console.error("useChecklistFields refresh error", err);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  // Initial load — seed missing template fields on first open
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await api.get(`/cases/${caseId}/checklist`);
        const data = (snakeKeys(res.data) as ChecklistRow[]) ?? [];

        const existingKeys = new Set(data.map((r) => r.field_key).filter(Boolean));
        const missing = template.filter((t) => !existingKeys.has(t.key));

        if (missing.length > 0) {
          // Seed missing fields via backend
          await Promise.allSettled(
            missing.map((t) =>
              api.post(`/cases/${caseId}/checklist/seed`, camelKeys({
                field_key: t.key,
                label: t.label,
                section: t.section,
                value: null,
                status: "missing",
              }))
            )
          );
          const refreshed = await api.get(`/cases/${caseId}/checklist`);
          if (!cancelled) setRows((snakeKeys(refreshed.data) as ChecklistRow[]) ?? []);
        } else {
          if (!cancelled) setRows(data);
        }
      } catch (err) {
        console.error("useChecklistFields load error", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [caseId, template]);

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
    const existing = byKey.get(fieldKey);
    if (!existing) return;
    try {
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
