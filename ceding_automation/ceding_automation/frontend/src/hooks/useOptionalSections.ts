// Stage 4 optional-section switches (With-Profit Funds, Guarantees,
// Protected Tax-Free Cash (Pre-A-Day)). The backend owns the rules — this
// hook just reads the effective state and flips it.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { optionalSectionsApi, type OptionalSectionState } from "@/lib/api";

export function useOptionalSections(caseId: string, onChanged?: () => void) {
  const [sections, setSections] = useState<OptionalSectionState[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await optionalSectionsApi.list(caseId);
      setSections(r.data.sections ?? []);
    } catch {
      setSections([]); // no switches rather than a broken panel
    }
  }, [caseId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setEnabled = useCallback(async (section: string, enabled: boolean) => {
    setBusy(section);
    try {
      const r = await optionalSectionsApi.set(caseId, section, enabled);
      setSections(r.data.sections ?? []);
      toast.success(enabled ? `${section} switched on` : `${section} marked not applicable`, {
        description: enabled ? "Fill in the fields below." : "All fields in this section are now N/A.",
      });
      onChanged?.();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error("Couldn't update the section", { description: msg ?? (err as Error).message });
    } finally {
      setBusy(null);
    }
  }, [caseId, onChanged]);

  const byName = new Map(sections.map((s) => [s.section, s]));
  return { sections, byName, busy, setEnabled, refresh };
}
