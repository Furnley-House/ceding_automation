// backend/src/utils/caseGuards.ts
//
// Stage 4 → 5 conflict guard and the NPW (Not Proceeding With) reasons.

import { CaseStatus } from "@prisma/client";

/** Statuses before Stage 5 (Call Assist). Moving any of these to Stage 5 or
 *  later means "Extract & Fill Gaps is done", which needs conflicts resolved. */
export const PRE_STAGE_5_STATUSES: CaseStatus[] = [
  CaseStatus.DRAFT,
  CaseStatus.STAGE_1_LOA_PREP,
  CaseStatus.STAGE_2_COLLECT_DETAILS,
  CaseStatus.STAGE_3_CRM_SETUP,
  CaseStatus.STAGE_4_PROVIDER_REQUEST,
];

export interface ConflictRowLike {
  confidence: string;
  isManuallyOverridden: boolean;
  templatePlanType: string;
  sectionName: string;
}

/**
 * Unresolved conflicts that block leaving Stage 4. Same rule as the
 * frontend's computeCaseStats "conflict" count: confidence CONFLICT and not
 * manually overridden (both resolve paths — PATCH with a value and POST
 * /resolve-conflict — move confidence off CONFLICT). Rows from another plan
 * type's template (orphans) and optional sections switched OFF don't count.
 */
export function countUnresolvedConflicts(
  rows: ConflictRowLike[],
  casePlanType: string,
  offSections: Set<string>,
): number {
  return rows.filter(
    (r) =>
      r.confidence === "CONFLICT" &&
      !r.isManuallyOverridden &&
      r.templatePlanType === casePlanType &&
      !offSections.has(r.sectionName),
  ).length;
}

/** NPW reasons offered at Stage 3 once the provider documents are in. */
export const NPW_REASONS = {
  OUT_OF_SCOPE_PLAN_TYPE: "Plan type out of scope (not Pension / ISA / GIA)",
  PLAN_CLOSED_OR_TRANSFERRED: "Plan already closed or transferred",
  CLIENT_NOT_PROCEEDING: "Client not proceeding",
  DUPLICATE_CASE: "Duplicate case",
  OTHER: "Other",
} as const;

export type NpwReasonCode = keyof typeof NPW_REASONS;

export function isNpwReasonCode(v: unknown): v is NpwReasonCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(NPW_REASONS, v);
}

/** Statuses a case can be marked NPW from: anything still in progress.
 *  Approved / complete cases are past the point of not proceeding. */
export function canMarkNpw(status: CaseStatus): boolean {
  return (
    status !== CaseStatus.APPROVED &&
    status !== CaseStatus.STAGE_10_COMPLETE &&
    status !== CaseStatus.CANCELLED
  );
}

/** Text stored on the case (Case.onHoldReason — the "why is this case
 *  parked" column, shared with On Hold) and shown on the NPW banner. */
export function npwReasonText(code: NpwReasonCode, note: string | undefined): string {
  const label = NPW_REASONS[code];
  const n = (note ?? "").trim();
  return n ? `NPW — ${label}: ${n}` : `NPW — ${label}`;
}
