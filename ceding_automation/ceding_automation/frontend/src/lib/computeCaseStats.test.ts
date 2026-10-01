import { describe, it, expect } from "vitest";
import { computeCaseStats, type ComputeCaseStatsInput, type ChecklistRowLike, type TemplateFieldLike } from "./computeCaseStats";
import type { ContributionRow } from "@/hooks/useContributions";

// Test scaffolding — minimal fixtures only. The helper is pure so no mocks.

function tpl(key: string, section = "Basic Details"): TemplateFieldLike {
  return { key, section };
}

function row(fieldKey: string, overrides: Partial<ChecklistRowLike> = {}): ChecklistRowLike {
  return {
    field_key: fieldKey,
    value: "value",
    confidence: "HIGH",
    status: "ai_extracted",
    manually_edited: false,
    ...overrides,
  };
}

// A minimal non-Pension input with no fund, no contribs, no off-sections.
function baseInput(fieldCount: number): ComputeCaseStatsInput {
  const visibleFields = Array.from({ length: fieldCount }, (_, i) => tpl(`field_${i}`));
  return {
    visibleFields,
    rows: visibleFields.map((f) => row(f.key)),
    offSections: new Set<string>(),
    fundStatus: "missing",
    contributions: [],
    planType: "ISA",
  };
}

describe("computeCaseStats — canonical denominator", () => {
  it("Pension total = scalars + 1 (Fund) + 2 (Contribs)", () => {
    const input = baseInput(69);
    input.planType = "PENSION";
    const s = computeCaseStats(input);
    expect(s.total).toBe(72);
    expect(s.breakdown.scalarsCounted).toBe(69);
    expect(s.breakdown.fundSlot).toBe(1);
    expect(s.breakdown.contribSlots).toBe(2);
  });

  it("ISA total = scalars + 1 (Fund) + 0 (no Contribs)", () => {
    const input = baseInput(37);
    input.planType = "ISA";
    const s = computeCaseStats(input);
    expect(s.total).toBe(38);
    expect(s.breakdown.contribSlots).toBe(0);
  });

  it("GIA total = scalars + 1 (Fund) + 0", () => {
    const input = baseInput(38);
    input.planType = "GIA";
    const s = computeCaseStats(input);
    expect(s.total).toBe(39);
    expect(s.breakdown.contribSlots).toBe(0);
  });

  it("accepts lowercase planType", () => {
    const input = baseInput(69);
    input.planType = "pension";
    expect(computeCaseStats(input).breakdown.contribSlots).toBe(2);
  });

  it("off-sections are excluded from the scalar count (Stage 4's rule, now shared)", () => {
    // 69 scalars, 3 of them in "Protected Tax-Free Cash (Pre-A-Day)" which is toggled off.
    const visibleFields: TemplateFieldLike[] = [
      ...Array.from({ length: 66 }, (_, i) => tpl(`field_${i}`, "Basic Details")),
      tpl("a_day_value", "Protected Tax-Free Cash (Pre-A-Day)"),
      tpl("a_day_tax_free_cash", "Protected Tax-Free Cash (Pre-A-Day)"),
      tpl("current_tax_free_cash", "Protected Tax-Free Cash (Pre-A-Day)"),
    ];
    const input: ComputeCaseStatsInput = {
      visibleFields,
      rows: visibleFields.map((f) => row(f.key, { value: null, confidence: "MISSING" })),
      offSections: new Set(["Protected Tax-Free Cash (Pre-A-Day)"]),
      fundStatus: "missing",
      contributions: [],
      planType: "PENSION",
    };
    const s = computeCaseStats(input);
    expect(s.breakdown.scalarsCounted).toBe(66);
    expect(s.breakdown.offSectionFieldsExcluded).toBe(3);
    expect(s.total).toBe(66 + 1 + 2); // 69
  });
});

describe("computeCaseStats — scalar classification precedence", () => {
  it("approved > review_requested > missing > pending", () => {
    const visibleFields = [
      tpl("f_approved"),
      tpl("f_review"),
      tpl("f_missing_value"),
      tpl("f_missing_confidence"),
      tpl("f_pending"),
    ];
    const rows: ChecklistRowLike[] = [
      row("f_approved", { status: "approved" }),
      row("f_review", { status: "review_requested" }),
      row("f_missing_value", { value: null, status: "ai_extracted" }),
      row("f_missing_confidence", { value: "x", confidence: "MISSING", status: "ai_extracted" }),
      row("f_pending", { status: "ai_extracted" }),
    ];
    const input: ComputeCaseStatsInput = {
      visibleFields, rows, offSections: new Set(),
      fundStatus: "filled", contributions: [], planType: "ISA",
    };
    const s = computeCaseStats(input);
    expect(s.approved).toBe(1);
    expect(s.review).toBe(1);
    // Fund is "filled" (1 grid slot filled); no contrib slots on ISA.
    // Missing = 2 scalars missing + 0 grid-missing = 2.
    expect(s.missing).toBe(2);
    expect(s.pending).toBe(1);
  });

  it("treats value='MISSING' (literal AI output) as missing, not pending", () => {
    const visibleFields = [tpl("f")];
    const rows = [row("f", { value: "MISSING", confidence: "HIGH", status: "ai_extracted" })];
    const input: ComputeCaseStatsInput = {
      visibleFields, rows, offSections: new Set(),
      fundStatus: "filled", contributions: [], planType: "ISA",
    };
    expect(computeCaseStats(input).missing).toBe(1);
    expect(computeCaseStats(input).pending).toBe(0);
  });

  it("counts confidence=CONFLICT as both a scalar bucket and a conflict subset", () => {
    const visibleFields = [tpl("f")];
    const rows = [row("f", { confidence: "CONFLICT", status: "ai_extracted" })];
    const input: ComputeCaseStatsInput = {
      visibleFields, rows, offSections: new Set(),
      fundStatus: "filled", contributions: [], planType: "ISA",
    };
    const s = computeCaseStats(input);
    expect(s.conflict).toBe(1);
    expect(s.pending).toBe(1); // not approved, not review, not missing
  });
});

describe("computeCaseStats — confidence bands (Stage 10 KPI behaviour)", () => {
  it("groups rows by uppercase confidence; empty/null confidence falls into MISSING", () => {
    const visibleFields = [tpl("a"), tpl("b"), tpl("c")];
    const rows = [
      row("a", { confidence: "HIGH" }),
      row("b", { confidence: null }),
      row("c", { confidence: "high" }),
    ];
    const input: ComputeCaseStatsInput = {
      visibleFields, rows, offSections: new Set(),
      fundStatus: "missing", contributions: [], planType: "ISA",
    };
    const s = computeCaseStats(input);
    expect(s.confidenceBands.HIGH).toBe(2);
    expect(s.confidenceBands.MISSING).toBe(1);
  });

  it("manually_overridden rows go into MANUALLY_OVERRIDDEN band, bypass confidence", () => {
    const visibleFields = [tpl("a")];
    const rows = [row("a", { confidence: "HIGH", manually_edited: true })];
    const input: ComputeCaseStatsInput = {
      visibleFields, rows, offSections: new Set(),
      fundStatus: "missing", contributions: [], planType: "ISA",
    };
    const s = computeCaseStats(input);
    expect(s.confidenceBands.MANUALLY_OVERRIDDEN).toBe(1);
    expect(s.confidenceBands.HIGH).toBeUndefined();
    expect(s.manualOverrides).toBe(1);
  });

  it("Carmel's '2 missing' scenario: the two contrib scalars no longer leak into the MISSING band — they're not in visibleFields in the first place after the standard CONTRIBUTIONS_LEGACY filter", () => {
    // The helper's input is already filtered — the caller (ApprovalWorkspace, Stage 4/6)
    // applies CONTRIBUTIONS_LEGACY_FIELD_KEYS. The 2 contrib scalars never reach visibleFields.
    // So on a Pension case with no scalars having confidence=MISSING, the MISSING band is empty.
    const visibleFields = [tpl("provider_name"), tpl("plan_number")];
    const rows = [
      row("provider_name", { confidence: "HIGH" }),
      row("plan_number", { confidence: "HIGH" }),
    ];
    const input: ComputeCaseStatsInput = {
      visibleFields, rows, offSections: new Set(),
      fundStatus: "filled", contributions: [],
      planType: "PENSION",
    };
    const s = computeCaseStats(input);
    expect(s.confidenceBands.MISSING).toBeUndefined();
    expect(s.confidenceBands.HIGH).toBe(2);
    // Grid slots are tracked separately — not in confidenceBands.
    expect(s.gridSlots.total).toBe(3);
  });
});

describe("computeCaseStats — grid slots and completion", () => {
  it("Pension with Fund filled + both contribs filled = gridSlots.filled 3 of 3", () => {
    const visibleFields = Array.from({ length: 69 }, (_, i) => tpl(`field_${i}`));
    const contribs: ContributionRow[] = [
      // Two cells with filled transactions on each of 4 positions.
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `c${i}`, caseId: "case", position: i + 1, taxYearLabel: `${2026 - i}/${2027 - i}`,
        amount: null, employerAiTotal: null, personalAiTotal: null,
        employerNotApplicableAt: null, personalNotApplicableAt: null,
        aiExtractedAt: null, createdAt: "", updatedAt: "",
        transactions: [
          { id: `tx_e_${i}`, type: "EMPLOYER" as const, amount: "100", source: "AI" as const, date: null, description: "", supersededAt: null, createdAt: "", updatedAt: "" },
          { id: `tx_p_${i}`, type: "PERSONAL" as const, amount: "100", source: "AI" as const, date: null, description: "", supersededAt: null, createdAt: "", updatedAt: "" },
        ],
      } as unknown as ContributionRow)),
    ];
    const input: ComputeCaseStatsInput = {
      visibleFields,
      rows: visibleFields.map((f) => row(f.key, { status: "approved" })),
      offSections: new Set(),
      fundStatus: "filled",
      contributions: contribs,
      planType: "PENSION",
    };
    const s = computeCaseStats(input);
    expect(s.total).toBe(72);
    expect(s.gridSlots.total).toBe(3);
    expect(s.gridSlots.filled).toBe(3);
    expect(s.missing).toBe(0);
    expect(s.completion).toBe(100);
  });

  it("Pension with no grid data = gridSlots.filled 0 of 3, those 3 bump missing", () => {
    const visibleFields = Array.from({ length: 69 }, (_, i) => tpl(`field_${i}`));
    const input: ComputeCaseStatsInput = {
      visibleFields,
      rows: visibleFields.map((f) => row(f.key, { status: "approved" })),
      offSections: new Set(),
      fundStatus: "missing",
      contributions: [],
      planType: "PENSION",
    };
    const s = computeCaseStats(input);
    expect(s.total).toBe(72);
    expect(s.gridSlots.filled).toBe(0);
    expect(s.missing).toBe(3); // only grids missing; all scalars approved
    expect(s.approved).toBe(69); // grids never bump approved pre-grid-UI (KI-17)
  });

  it("gridSlots.reviewed is always 0 pre-grid-approval-UI", () => {
    const input = baseInput(10);
    input.planType = "PENSION";
    input.fundStatus = "filled";
    expect(computeCaseStats(input).gridSlots.reviewed).toBe(0);
  });

  it("completion = round((total - missing) / total * 100)", () => {
    const visibleFields = Array.from({ length: 10 }, (_, i) => tpl(`f${i}`));
    const rows = visibleFields.map((f, i) =>
      row(f.key, i < 7 ? { status: "ai_extracted" } : { value: null, confidence: "MISSING" }),
    );
    const input: ComputeCaseStatsInput = {
      visibleFields, rows, offSections: new Set(),
      fundStatus: "filled", contributions: [], planType: "ISA",
    };
    const s = computeCaseStats(input);
    // total = 10 + 1 (fund) = 11. missing = 3 scalars + 0 grid (fund filled) = 3.
    // completion = round((11 - 3) / 11 * 100) = round(72.72) = 73.
    expect(s.total).toBe(11);
    expect(s.missing).toBe(3);
    expect(s.completion).toBe(73);
  });

  it("empty template → total 0, completion 0 (no divide-by-zero)", () => {
    const input: ComputeCaseStatsInput = {
      visibleFields: [], rows: [], offSections: new Set(),
      fundStatus: "missing", contributions: [], planType: "ISA",
    };
    const s = computeCaseStats(input);
    expect(s.total).toBe(1); // just fund slot
    expect(s.missing).toBe(1);
    expect(s.completion).toBe(0);
  });
});
