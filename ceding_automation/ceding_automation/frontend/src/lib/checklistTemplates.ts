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

/** Plan types we currently support end-to-end. Anything else is flagged. */
export const SUPPORTED_PLAN_TYPES = ["Personal Pension", "ISA", "GIA"] as const;
export type SupportedPlanType = (typeof SUPPORTED_PLAN_TYPES)[number];

export function isSupportedPlanType(planType: string | null | undefined): planType is SupportedPlanType {
  return !!planType && (SUPPORTED_PLAN_TYPES as readonly string[]).includes(planType);
}

// Canonical plan arrays are keyed by uppercase enum names; the frontend public
// API still uses display strings ("Personal Pension"/"ISA"/"GIA"). The bridge
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
  "Personal Pension": PENSION_FIELDS,
  ISA: ISA_FIELDS,
  GIA: GIA_FIELDS,
};

export function getTemplate(planType: string): ChecklistFieldDef[] {
  return CHECKLIST_TEMPLATES[planType] ?? [];
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
