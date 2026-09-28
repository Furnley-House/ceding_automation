// backend/src/services/optionalSections.ts
//
// Optional checklist sections — With-Profit Funds, Guarantees, Protected
// Tax-Free Cash (Pre-A-Day). Many plans have none of these, so on Stage 4
// the CA gets an on/off switch per section instead of typing "N/A" into
// every field:
//
//   OFF → section collapsed; every field in it is written as "N/A".
//   ON  → section opens; fields that were "N/A" are cleared to blank so
//         the CA can fill them in.
//
// State per case lives in Case.sectionToggles ({ "<section>": boolean }).
// A section with no explicit entry is ON if any of its fields holds real
// data (e.g. the AI extracted a with-profit fund), otherwise OFF. OFF
// sections the CA never touched get their "N/A" written when Stage 4 is
// marked complete (applyOptionalSectionDefaults).

import { PrismaClient, Prisma, PlanType } from "@prisma/client";
import { shouldClearApproval } from "../utils/approvalOnEdit";

const prisma = new PrismaClient();

export const OPTIONAL_SECTIONS = [
  "With-Profit Funds",
  "Guarantees",
  "Protected Tax-Free Cash (Pre-A-Day)",
] as const;
export type OptionalSection = (typeof OPTIONAL_SECTIONS)[number];

export const NA_VALUE = "N/A";

export function isOptionalSection(s: string): s is OptionalSection {
  return (OPTIONAL_SECTIONS as readonly string[]).includes(s);
}

/** "N/A", "n/a", "NA" — the value the toggle writes, plus how CAs type it. */
export function isNotApplicableValue(v: string | null | undefined): boolean {
  const t = (v ?? "").trim().toUpperCase();
  return t === "N/A" || t === "NA";
}

/** A value that counts as real data (not blank, not MISSING, not N/A). */
export function isRealValue(v: string | null | undefined): boolean {
  const t = (v ?? "").trim();
  return t !== "" && t.toUpperCase() !== "MISSING" && !isNotApplicableValue(t);
}

export interface SectionState {
  section: OptionalSection;
  enabled: boolean;
  /** True when the CA has explicitly chosen; false = derived from data. */
  explicit: boolean;
  fieldCount: number;
  /** Fields holding real data — what switching OFF would replace. */
  realValueCount: number;
}

/** Pure: resolve one section's state from the stored choice + its values. */
export function deriveSectionState(
  section: OptionalSection,
  explicitChoice: boolean | undefined,
  values: Array<string | null>,
): SectionState {
  const realValueCount = values.filter(isRealValue).length;
  return {
    section,
    enabled: explicitChoice ?? realValueCount > 0,
    explicit: explicitChoice !== undefined,
    fieldCount: values.length,
    realValueCount,
  };
}

function readToggles(raw: Prisma.JsonValue | null): Record<string, boolean> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "boolean") out[k] = v;
  return out;
}

async function loadCaseSections(caseId: string) {
  const caseRow = await prisma.case.findUnique({
    where: { id: caseId },
    select: { id: true, planType: true, sectionToggles: true },
  });
  if (!caseRow) return null;
  const templates = await prisma.checklistTemplate.findMany({
    where: { planType: caseRow.planType as PlanType, isActive: true, sectionName: { in: [...OPTIONAL_SECTIONS] } },
    select: { id: true, sectionName: true, fieldKey: true },
  });
  const fields = await prisma.checklistField.findMany({
    where: { caseId, templateId: { in: templates.map((t) => t.id) } },
    select: { id: true, templateId: true, value: true, isApproved: true },
  });
  const fieldByTemplate = new Map(fields.map((f) => [f.templateId, f]));
  return { caseRow, templates, fieldByTemplate, toggles: readToggles(caseRow.sectionToggles) };
}

/** Effective state of every optional section that exists for this plan. */
export async function getOptionalSectionStates(caseId: string): Promise<SectionState[] | null> {
  const ctx = await loadCaseSections(caseId);
  if (!ctx) return null;
  return OPTIONAL_SECTIONS.flatMap((section) => {
    const tpls = ctx.templates.filter((t) => t.sectionName === section);
    if (tpls.length === 0) return []; // section doesn't exist on this plan type
    const values = tpls.map((t) => ctx.fieldByTemplate.get(t.id)?.value ?? null);
    return [deriveSectionState(section, ctx.toggles[section], values)];
  });
}

/**
 * Switch a section on/off for a case and rewrite its fields accordingly.
 * OFF: every field → "N/A" (approvals on changed values are cleared).
 * ON : fields that are "N/A" → blank / MISSING.
 * Unchanged fields are left alone. Returns the fresh section states.
 */
export async function setOptionalSection(args: {
  caseId: string;
  section: OptionalSection;
  enabled: boolean;
  userId: string;
  /** "toggle" (CA flipped the switch) or "stage-complete" (default N/A). */
  via: "toggle" | "stage-complete";
}): Promise<SectionState[] | null> {
  const ctx = await loadCaseSections(args.caseId);
  if (!ctx) return null;
  const tpls = ctx.templates.filter((t) => t.sectionName === args.section);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    for (const tpl of tpls) {
      const field = ctx.fieldByTemplate.get(tpl.id);
      const oldValue = field?.value ?? null;

      let data: Prisma.ChecklistFieldUncheckedUpdateInput | null = null;
      let newValue: string | null = null;
      if (!args.enabled) {
        if (isNotApplicableValue(oldValue) && oldValue?.trim() === NA_VALUE) continue; // already N/A
        newValue = NA_VALUE;
        const clearApproval = shouldClearApproval(field?.isApproved ?? false, oldValue, NA_VALUE);
        data = {
          value: NA_VALUE,
          confidence: "HIGH",
          status: "MANUALLY_OVERRIDDEN",
          isManuallyOverridden: true,
          manualEditedById: args.userId,
          manualEditedAt: now,
          ...(clearApproval ? { isApproved: false, approvedAt: null } : {}),
        };
      } else {
        if (!field || !isNotApplicableValue(oldValue)) continue; // only clear N/A
        newValue = null;
        data = {
          value: null,
          confidence: "MISSING",
          status: "MANUALLY_OVERRIDDEN",
          isManuallyOverridden: true,
          manualEditedById: args.userId,
          manualEditedAt: now,
          ...(field.isApproved ? { isApproved: false, approvedAt: null } : {}),
        };
      }

      let fieldId: string;
      if (field) {
        await tx.checklistField.update({ where: { id: field.id }, data });
        fieldId = field.id;
      } else {
        const created = await tx.checklistField.create({
          data: { ...(data as Prisma.ChecklistFieldUncheckedCreateInput), caseId: args.caseId, templateId: tpl.id },
          select: { id: true },
        });
        fieldId = created.id;
      }
      await tx.auditLog.create({
        data: {
          caseId: args.caseId,
          userId: args.userId,
          action: "FIELD_EDITED",
          fieldId,
          fieldKey: tpl.fieldKey,
          oldValue,
          newValue,
          source: "MANUAL",
          metadata: { via: `optional-section-${args.via}`, section: args.section },
        },
      });
    }

    const toggles = { ...ctx.toggles, [args.section]: args.enabled };
    await tx.case.update({ where: { id: args.caseId }, data: { sectionToggles: toggles } });
    await tx.auditLog.create({
      data: {
        caseId: args.caseId,
        userId: args.userId,
        action: "CASE_UPDATED",
        source: "MANUAL",
        newValue: args.enabled
          ? `Section "${args.section}" switched on`
          : `Section "${args.section}" marked not applicable`,
        metadata: { optionalSection: args.section, enabled: args.enabled, via: args.via },
      },
    });
  });

  return getOptionalSectionStates(args.caseId);
}

/**
 * Stage 4 "Mark complete": write N/A for every optional section that is
 * OFF by default (never explicitly chosen, no real data). Explicit choices
 * and sections holding data are left alone. Returns the sections changed.
 */
export async function applyOptionalSectionDefaults(caseId: string, userId: string): Promise<OptionalSection[]> {
  const states = await getOptionalSectionStates(caseId);
  if (!states) return [];
  const changed: OptionalSection[] = [];
  for (const s of states) {
    if (s.explicit || s.enabled) continue;
    await setOptionalSection({ caseId, section: s.section, enabled: false, userId, via: "stage-complete" });
    changed.push(s.section);
  }
  return changed;
}
