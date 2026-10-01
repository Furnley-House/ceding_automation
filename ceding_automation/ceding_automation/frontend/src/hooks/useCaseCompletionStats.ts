// Thin React wrapper around lib/computeCaseStats. Composes the three
// data hooks (useChecklistFields, useFundLines, useContributions) so a
// stage component gets one call that returns the shared stats shape.
//
// NOT a replacement for useChecklistFields — callers still need `rows`
// for rendering the field list. This hook is a stats-only layer.

import { useMemo } from "react";
import {
  useChecklistFields,
  fundDetailsStatus,
  type ChecklistRow,
  type FundDetailsStatus,
} from "@/hooks/useChecklistFields";
import { useFundLines } from "@/hooks/useFundLines";
import { useContributions } from "@/hooks/useContributions";
import { useOptionalSections } from "@/hooks/useOptionalSections";
import {
  getTemplate,
  CONTRIBUTIONS_LEGACY_FIELD_KEYS,
  type ChecklistFieldDef,
} from "@/lib/checklistTemplates";
import { contributionsProgress } from "@/lib/contributionsDerivation";
import { computeCaseStats, type CaseStats } from "@/lib/computeCaseStats";

export interface UseCaseCompletionStatsArgs {
  caseId: string;
  planType: string | null | undefined;
}

export interface UseCaseCompletionStatsResult {
  stats: CaseStats;
  loading: boolean;
  /** Convenience re-export so callers that need rows for rendering can take them
   *  from the same hook (saves an extra useChecklistFields call). */
  rows: ChecklistRow[];
  /** visibleFields after showIf + CONTRIBUTIONS_LEGACY filter — same as each
   *  stage computes locally today. Re-exported so callers can iterate. */
  visibleFields: ChecklistFieldDef[];
  /** Fund Details status — re-exported so stages can fold it into their
   *  own display counts (e.g. Stage 4's HIGH/LOW/MISSING chips) without
   *  recomputing fundDetailsStatus(fundLines) locally. */
  fundStatus: FundDetailsStatus;
  /** Contribution grid fill counts, pre-computed for display folds. */
  contribProgress: { add: number; filled: number };
}

export function useCaseCompletionStats({
  caseId,
  planType,
}: UseCaseCompletionStatsArgs): UseCaseCompletionStatsResult {
  const template = useMemo(() => getTemplate(planType), [planType]);
  const { rows, loading, byKey } = useChecklistFields({ caseId, template });
  const { rows: fundLines } = useFundLines(caseId);
  const isPension = (planType ?? "").toUpperCase() === "PENSION";
  const { rows: contributions } = useContributions(caseId, isPension);
  const optional = useOptionalSections(caseId);

  const fundStatus = useMemo(() => fundDetailsStatus(fundLines), [fundLines]);

  const visibleFields = useMemo(
    () =>
      template.filter((f) => {
        // Pension-only filter — matches ApprovalWorkspace.tsx:88-89 /
        // stages.tsx:320 / ChecklistPanel.tsx:220. Replicating here so
        // every stats consumer gets the same visibleFields set.
        if (isPension && CONTRIBUTIONS_LEGACY_FIELD_KEYS.has(f.key)) return false;
        if (!f.showIf) return true;
        const dependent = byKey.get(f.showIf.key)?.value;
        return dependent ? f.showIf.in.includes(dependent) : false;
      }),
    [template, byKey, isPension],
  );

  const offSections = useMemo(() => {
    const sections: string[] = [];
    for (const s of optional.sections) {
      if (!s.enabled) sections.push(s.section);
    }
    return new Set(sections);
  }, [optional.sections]);

  const contribProgress = useMemo(
    () => contributionsProgress(contributions, isPension ? "PENSION" : null),
    [contributions, isPension],
  );

  const stats = useMemo(
    () =>
      computeCaseStats({
        visibleFields,
        rows,
        offSections,
        fundStatus,
        contributions,
        planType,
      }),
    [visibleFields, rows, offSections, fundStatus, contributions, planType],
  );

  return { stats, loading, rows, visibleFields, fundStatus, contribProgress };
}
