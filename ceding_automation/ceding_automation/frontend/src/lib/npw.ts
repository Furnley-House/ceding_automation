// frontend/src/lib/npw.ts
//
// NPW (Not Proceeding With) reasons — mirror of NPW_REASONS in
// backend/src/utils/caseGuards.ts. Keep the codes in step.

export const NPW_REASONS = [
  { code: "OUT_OF_SCOPE_PLAN_TYPE", label: "Plan type out of scope (not Pension / ISA / GIA)" },
  { code: "PLAN_CLOSED_OR_TRANSFERRED", label: "Plan already closed or transferred" },
  { code: "CLIENT_NOT_PROCEEDING", label: "Client not proceeding" },
  { code: "DUPLICATE_CASE", label: "Duplicate case" },
  { code: "OTHER", label: "Other" },
] as const;

export type NpwReasonCode = (typeof NPW_REASONS)[number]["code"];
