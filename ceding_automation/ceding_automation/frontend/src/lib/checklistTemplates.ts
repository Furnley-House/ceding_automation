// Checklist field templates per plan type — loaded from the shared canonical
// JSON (../../shared-contracts/checklist-fields-v1.json at repo level;
// mirrored to src/lib/canonical/ so Vite can resolve it at build time).
// The backend (prisma/seed.ts) and the BFF (separate repo) load the same
// JSON — this file is the frontend's view of it.
//
// Note: fund_lines is type=table in the canonical and has no frontend UI yet;
// it's filtered out below. Structured fund rows live in the backend's
// ChecklistFundLine model and will get a dedicated UI in a follow-up PR.

import canonical from "./canonical/checklist-fields-v1.json";

export type FieldType = "text" | "number" | "currency" | "percent" | "yesno" | "date" | "select";

export interface ChecklistFieldDef {
  key: string;
  label: string;
  type: FieldType;
  section: string;
  options?: string[];
  required?: boolean;
  /** Optional condition: only show when another field equals one of these values */
  showIf?: { key: string; in: string[] };
  hint?: string;
}

/** Plan types we currently support end-to-end. Anything else is flagged.
 *  Phase 1: Pension / ISA / GIA only. "Personal Pension" is a PlanSubType
 *  (asked for inside the checklist), not a top-level plan type. */
export const SUPPORTED_PLAN_TYPES = ["Pension", "ISA", "GIA"] as const;
export type SupportedPlanType = (typeof SUPPORTED_PLAN_TYPES)[number];

// Legacy display strings that used to appear as a plan type before we
// reorganised pension sub-types. Anything in this list is treated as if it
// were "Pension" so existing data and seed fixtures keep resolving.
const LEGACY_PENSION_ALIASES = new Set([
  "Personal Pension",
  "Stakeholder Pension",
  "With-Profits Pension",
  "SIPP",
  "PENSION", // backend enum value
  "pension",
]);

function normalisePlanType(planType: string | null | undefined): string | null {
  if (!planType) return null;
  if (LEGACY_PENSION_ALIASES.has(planType)) return "Pension";
  return planType;
}

export function isSupportedPlanType(planType: string | null | undefined): planType is SupportedPlanType {
  const n = normalisePlanType(planType);
  return !!n && (SUPPORTED_PLAN_TYPES as readonly string[]).includes(n);
}

// Canonical plan arrays are keyed by uppercase enum names; the frontend public
// API uses friendly display strings ("Pension"/"ISA"/"GIA"). The bridge
// happens in CHECKLIST_TEMPLATES below — importers don't need to change.
type CanonicalPlanKey = "PENSION" | "ISA" | "GIA";

interface CanonicalField {
  key: string;
  label: string;
  section: string;
  type: string;
  required: boolean;
  options?: string[];
  note?: string;
  display_order: number;
  // v1.1 extras carried in the JSON but unused by the frontend yet:
  // typical_values, normalize_per, accepts_non_applicable_markers,
  // allows_defer_to_source, defer_examples, auto_extract_hint,
  // parent_field, columns, section_order
}

interface Canonical {
  version: string;
  plans: Record<CanonicalPlanKey, CanonicalField[]>;
}

// Map canonical type strings → frontend FieldType vocabulary (what
// ChecklistField.tsx switches on). Backend uses different strings
// (yes_no, percentage, free_text, table) — we use the frontend's.
function mapType(canonicalType: string): FieldType {
  switch (canonicalType) {
    case "text": return "text";
    case "text_long": return "text"; // frontend has no multiline variant yet
    case "date": return "date";
    case "currency": return "currency";
    case "percent": return "percent";
    case "boolean": return "yesno";
    case "dropdown": return "select";
    case "url": return "text";
    // "table" (fund_lines) is filtered out before reaching mapType.
    default: return "text";
  }
}

function toFieldDef(f: CanonicalField): ChecklistFieldDef {
  const def: ChecklistFieldDef = {
    key: f.key,
    label: f.label,
    type: mapType(f.type),
    section: f.section,
  };
  if (f.required) def.required = true;
  if (f.options) def.options = f.options;
  if (f.note) def.hint = f.note;
  return def;
}

function buildPlan(planKey: CanonicalPlanKey): ChecklistFieldDef[] {
  return (canonical as Canonical).plans[planKey]
    .filter((f) => f.type !== "table")
    .map(toFieldDef);
}

const PENSION_FIELDS = buildPlan("PENSION");
const ISA_FIELDS = buildPlan("ISA");
const GIA_FIELDS = buildPlan("GIA");

export const CHECKLIST_TEMPLATES: Record<string, ChecklistFieldDef[]> = {
  Pension: PENSION_FIELDS,
  ISA: ISA_FIELDS,
  GIA: GIA_FIELDS,
};

export function getTemplate(planType: string): ChecklistFieldDef[] {
  // Normalise legacy / enum-style strings ("Personal Pension", "PENSION", etc.)
  // so a case carrying any historic plan_type still finds its template.
  const key = normalisePlanType(planType) ?? planType;
  return CHECKLIST_TEMPLATES[key] ?? [];
}

/** Section ordering preserved as encountered in the template */
export function groupBySection(fields: ChecklistFieldDef[]): { section: string; fields: ChecklistFieldDef[] }[] {
  const order: string[] = [];
  const map: Record<string, ChecklistFieldDef[]> = {};
  for (const f of fields) {
    if (!map[f.section]) {
      map[f.section] = [];
      order.push(f.section);
    }
    map[f.section].push(f);
  }
  return order.map((s) => ({ section: s, fields: map[s] }));
}
