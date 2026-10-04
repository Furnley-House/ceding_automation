// Shared case-stats computation. Replaces per-stage stats memos that
// previously disagreed on the same case:
//   - Stage 4  (ChecklistPanel)       → 72 for Pension (counted off-sections)
//   - Stage 6  (stages.tsx)           → 72 for Pension (NO off-sections filter)
//   - Stage 8  (ApprovalWorkspace)    → 69 for Pension (scalars only)
//   - Stage 10 (CaseKpiPanel)         → 70 for Pension (hook-filtered rows)
//
// After this helper: all four agree on the canonical total using Stage 4's
// convention (scalars after off-sections + 1 Fund + 2 Contribs on Pension).
//
// NOT a consumer: Stage 9 ExportWorkspace. It mirrors the CA's manual XLSX
// template and counts export cells — deliberately different scope.
//
// Verified in session audit 2026-10-01: Carmel Johnson's 27 PENSION cases
// where both contribution scalars have confidence="MISSING" with no value
// have been showing a "2 missing" tile on Stage 10 KPI that the paraplanner
// can't action (the scalars are hidden from ApprovalWorkspace by
// CONTRIBUTIONS_LEGACY_FIELD_KEYS). This helper folds those two scalars
// into the Contributions grid synthetic slots so the KPI stops counting
// them individually. See the commit message for the test note Revathy
// walks through.

import type { ContributionRow } from "@/hooks/useContributions";
import { contributionsProgress } from "@/lib/contributionsDerivation";

export interface TemplateFieldLike {
  key: string;
  section: string;
}

export interface ChecklistRowLike {
  field_key?: string | null;
  value?: string | null;
  confidence?: string | null;
  status?: string | null;
  manually_edited?: boolean;
}

export type FundStatus = "filled" | "review" | "missing";

export interface ComputeCaseStatsInput {
  /** Template fields already filtered for showIf + CONTRIBUTIONS_LEGACY_FIELD_KEYS. */
  visibleFields: TemplateFieldLike[];
  /** DB rows for this case (hook-filtered — fund_lines + fieldType=table dropped). */
  rows: ChecklistRowLike[];
  /** Sections toggled off (not applicable). Scalar fields in these sections are excluded. */
  offSections: Set<string>;
  /** Fund Details widget status, from fundDetailsStatus(fundLines). */
  fundStatus: FundStatus;
  /** Contributions grid rows for the case (empty / ignored on non-Pension). */
  contributions: ContributionRow[];
  /** Plan type (uppercase enum literal or lowercase string). Only Pension gets contrib slots. */
  planType: string | null | undefined;
}

export interface CaseStats {
  /** Canonical total: counted scalars + 1 (Fund) + 0 or 2 (Contribs). */
  total: number;
  /** Scalars with status === "approved". Grids are never approved pre-grid-UI (KI-17). */
  approved: number;
  /** Scalars with value, not approved, not review-requested, not missing. */
  pending: number;
  /** Scalars with status === "review_requested". */
  review: number;
  /** Subset of `review` with no value — a missing field the paraplanner sent
   *  back. Counted as review (not missing) above so the buckets stay
   *  mutually exclusive; views that count by value (Stage 6 Filled /
   *  Missing) add it back to missing. */
  reviewEmpty: number;
  /** Scalar missing + unfilled grid slots. */
  missing: number;
  /** Scalars where confidence === "CONFLICT". Subset of review bucket, for display. */
  conflict: number;
  /** 0–100: round((total − missing) / total × 100). */
  completion: number;
  /** Confidence-band breakdown for Stage 10 KPI. Scalars only (grids live in gridSlots). */
  confidenceBands: Record<string, number>;
  /** Manual-override count for Stage 10 KPI's dedicated card. Scalars only. */
  manualOverrides: number;
  /** Grid slot status for Stage 10 KPI's "Grids: X of Y reviewed" line. */
  gridSlots: {
    /** 1 (Fund always) + 2 (Pension Contribs) = 1 or 3. */
    total: number;
    /** Slots with data populated (fund has non-empty rows; contrib has non-zero tx per grid). */
    filled: number;
    /** Slots the paraplanner has signed off. 0 pre-grid-approval-UI (KI-17). */
    reviewed: number;
  };
  /** Breakdown of what went into `total`. For tests + debuggability. */
  breakdown: {
    scalarsCounted: number;
    offSectionFieldsExcluded: number;
    fundSlot: 1;
    contribSlots: 0 | 2;
  };
}

function isPensionPlan(planType: string | null | undefined): boolean {
  const n = (planType ?? "").toUpperCase();
  return n === "PENSION" || n.startsWith("PENSION");
}

// Mirror of isMissing from useChecklistFields.ts — repeated here so the pure
// helper has no React dependency.
function isMissingValue(row: ChecklistRowLike | undefined): boolean {
  if (!row) return true;
  const v = (row.value ?? "").trim();
  if (v === "") return true;
  if (v.toUpperCase() === "MISSING") return true;
  const conf = (row.confidence ?? "").toString().toUpperCase();
  if (conf === "MISSING") return true;
  return false;
}

export function computeCaseStats(input: ComputeCaseStatsInput): CaseStats {
  const { visibleFields, rows, offSections, fundStatus, contributions, planType } = input;

  const scalarsCounted = visibleFields.filter((f) => !offSections.has(f.section));
  const offSectionFieldsExcluded = visibleFields.length - scalarsCounted.length;

  const byKey = new Map<string, ChecklistRowLike>();
  for (const r of rows) {
    if (r.field_key) byKey.set(r.field_key, r);
  }

  let approved = 0;
  let pending = 0;
  let review = 0;
  let reviewEmpty = 0;
  let scalarMissing = 0;
  let conflict = 0;
  let manualOverrides = 0;
  const confidenceBands: Record<string, number> = {};

  for (const f of scalarsCounted) {
    const r = byKey.get(f.key);

    // Confidence banding — same rule as CaseKpiPanel.tsx:97-110 so the KPI
    // migration preserves its band semantic exactly.
    const statusLower = typeof r?.status === "string" ? r.status.toLowerCase() : "";
    const isManual = r?.manually_edited === true || statusLower === "manually_overridden";
    if (isManual) manualOverrides += 1;
    const band = isManual
      ? "MANUALLY_OVERRIDDEN"
      : typeof r?.confidence === "string" && r.confidence.length > 0
        ? r.confidence.toUpperCase()
        : "MISSING";
    confidenceBands[band] = (confidenceBands[band] ?? 0) + 1;

    // Mutually exclusive classification by precedence (matches ApprovalWorkspace):
    //   approved > review_requested > isMissing > pending
    if (r?.status === "approved") {
      approved += 1;
    } else if (r?.status === "review_requested") {
      review += 1;
      if (isMissingValue(r)) reviewEmpty += 1;
    } else if (isMissingValue(r)) {
      scalarMissing += 1;
    } else {
      pending += 1;
    }
    if (!isManual && typeof r?.confidence === "string" && r.confidence.toUpperCase() === "CONFLICT") {
      conflict += 1;
    }
  }

  // Grid slots: 1 (Fund always) + 2 (Pension Contribs) or 0 (ISA/GIA).
  const fundSlot: 1 = 1;
  const contribSlots: 0 | 2 = isPensionPlan(planType) ? 2 : 0;
  const gridSlotsTotal = fundSlot + contribSlots;

  const contribProgress = contributionsProgress(
    contributions,
    isPensionPlan(planType) ? "PENSION" : null,
  );

  const fundFilled = fundStatus !== "missing" ? 1 : 0;
  const gridSlotsFilled = fundFilled + contribProgress.filled;

  // Pre-grid-UI (KI-17): grids are never explicitly reviewed/approved.
  const gridSlotsReviewed = 0;

  // Aggregate missing: scalars + unfilled grid slots.
  const gridMissing = gridSlotsTotal - gridSlotsFilled;
  const missing = scalarMissing + gridMissing;

  const total = scalarsCounted.length + fundSlot + contribSlots;
  const completion = total === 0 ? 0 : Math.round(((total - missing) / total) * 100);

  return {
    total,
    approved,
    pending,
    review,
    reviewEmpty,
    missing,
    conflict,
    completion,
    confidenceBands,
    manualOverrides,
    gridSlots: {
      total: gridSlotsTotal,
      filled: gridSlotsFilled,
      reviewed: gridSlotsReviewed,
    },
    breakdown: {
      scalarsCounted: scalarsCounted.length,
      offSectionFieldsExcluded,
      fundSlot,
      contribSlots,
    },
  };
}
