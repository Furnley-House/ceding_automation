import { describe, it, expect } from "vitest";
import {
  sumCellTotal,
  shouldShowConflictMarker,
  isGridFilled,
  contributionsProgress,
} from "./contributionsDerivation";
import type { ContributionRow, ContributionTransaction } from "@/hooks/useContributions";

// ── Fixtures ──────────────────────────────────────────────────────────────

function tx(overrides: Partial<ContributionTransaction> = {}): ContributionTransaction {
  return {
    id: overrides.id ?? "tx-1",
    contributionId: overrides.contributionId ?? "contrib-1",
    type: overrides.type ?? "EMPLOYER",
    date: overrides.date !== undefined ? overrides.date : "2025-09-15",
    amount: overrides.amount ?? "1000.00",
    description: overrides.description ?? "Reg Pension Contribution (Employer)",
    documentId: overrides.documentId !== undefined ? overrides.documentId : "doc-1",
    sourcePage: overrides.sourcePage !== undefined ? overrides.sourcePage : 4,
    sourceRef: overrides.sourceRef !== undefined ? overrides.sourceRef : null,
    source: overrides.source ?? "AI",
    supersededAt: overrides.supersededAt !== undefined ? overrides.supersededAt : null,
    createdAt: overrides.createdAt ?? "2026-09-07T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-07T12:00:00.000Z",
  };
}

function row(overrides: Partial<ContributionRow> = {}): ContributionRow {
  return {
    id: overrides.id ?? "contrib-1",
    caseId: overrides.caseId ?? "case-1",
    position: overrides.position ?? 1,
    taxYearLabel: overrides.taxYearLabel ?? "2025/26",
    amount: overrides.amount ?? null,
    employerAiTotal: overrides.employerAiTotal !== undefined ? overrides.employerAiTotal : null,
    personalAiTotal: overrides.personalAiTotal !== undefined ? overrides.personalAiTotal : null,
    transactions: overrides.transactions ?? [],
    createdAt: overrides.createdAt ?? "2026-09-07T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-07T12:00:00.000Z",
  };
}

// ── sumCellTotal ──────────────────────────────────────────────────────────

describe("sumCellTotal", () => {
  it("returns 0 for an empty transaction list", () => {
    expect(sumCellTotal([], "EMPLOYER")).toBe(0);
  });

  it("sums only transactions of the requested type", () => {
    const txns = [
      tx({ id: "e1", type: "EMPLOYER", amount: "1000.00" }),
      tx({ id: "e2", type: "EMPLOYER", amount: "500.50" }),
      tx({ id: "p1", type: "PERSONAL", amount: "999.99" }),
    ];
    expect(sumCellTotal(txns, "EMPLOYER")).toBeCloseTo(1500.5, 2);
    expect(sumCellTotal(txns, "PERSONAL")).toBeCloseTo(999.99, 2);
  });

  it("excludes superseded rows even if backend returned them", () => {
    // Defence in depth — GET filters at the query level, but the
    // client should not double-count if that ever changes.
    const txns = [
      tx({ id: "e1", type: "EMPLOYER", amount: "1000.00" }),
      tx({ id: "e2", type: "EMPLOYER", amount: "5000.00", supersededAt: "2026-09-07T12:00:00.000Z" }),
    ];
    expect(sumCellTotal(txns, "EMPLOYER")).toBe(1000);
  });
});

// ── shouldShowConflictMarker ─────────────────────────────────────────────

describe("shouldShowConflictMarker", () => {
  it("null AiTotal → no marker (AI never emitted a total)", () => {
    expect(shouldShowConflictMarker(null, [tx()], "EMPLOYER")).toBe(false);
  });

  it("AiTotal matches sum of AI children within tolerance → no marker", () => {
    const txns = [
      tx({ id: "e1", amount: "1000.00" }),
      tx({ id: "e2", amount: "500.00" }),
    ];
    expect(shouldShowConflictMarker("1500.00", txns, "EMPLOYER")).toBe(false);
  });

  it("difference under £0.01 → no marker (float-noise tolerance)", () => {
    const txns = [tx({ amount: "1500.001" })];
    expect(shouldShowConflictMarker("1500.00", txns, "EMPLOYER")).toBe(false);
  });

  it("difference over £0.01 → marker fires", () => {
    const txns = [tx({ amount: "1000.00" })];
    expect(shouldShowConflictMarker("1500.00", txns, "EMPLOYER")).toBe(true);
  });

  it("cell has a non-superseded MANUAL row → NO marker (CA has taken ownership)", () => {
    const txns = [
      tx({ id: "ai-1", source: "AI", amount: "1000.00" }),
      tx({ id: "manual-1", source: "MANUAL", amount: "9999.99", date: null, documentId: null }),
    ];
    // AiTotal 1500 vs AI-sum 1000 = difference of 500, would fire...
    // ... except a MANUAL row exists → suppress.
    expect(shouldShowConflictMarker("1500.00", txns, "EMPLOYER")).toBe(false);
  });

  it("cell has a SUPERSEDED MANUAL row → marker still fires (only NON-superseded manual suppresses)", () => {
    const txns = [
      tx({ id: "ai-1", source: "AI", amount: "1000.00" }),
      tx({
        id: "manual-old",
        source: "MANUAL",
        amount: "9999.99",
        supersededAt: "2026-09-07T11:00:00.000Z",
      }),
    ];
    expect(shouldShowConflictMarker("1500.00", txns, "EMPLOYER")).toBe(true);
  });

  it("only looks at the requested type — PERSONAL manual doesn't suppress EMPLOYER marker", () => {
    const txns = [
      tx({ id: "e-ai", type: "EMPLOYER", source: "AI", amount: "1000.00" }),
      tx({ id: "p-manual", type: "PERSONAL", source: "MANUAL", amount: "5000.00" }),
    ];
    expect(shouldShowConflictMarker("1500.00", txns, "EMPLOYER")).toBe(true);
  });

  it("AiTotal set but no AI children (all superseded) → marker fires (AiTotal-vs-zero divergence)", () => {
    // Legitimate edge: AI wrote a total but every AI child was
    // superseded and there's no MANUAL either — something odd
    // happened, reviewer should look.
    const txns = [
      tx({ source: "AI", amount: "1000.00", supersededAt: "2026-09-07T11:00:00.000Z" }),
    ];
    expect(shouldShowConflictMarker("1500.00", txns, "EMPLOYER")).toBe(true);
  });
});

// ── isGridFilled ─────────────────────────────────────────────────────────

describe("isGridFilled", () => {
  it("empty rows → false", () => {
    expect(isGridFilled([], "EMPLOYER")).toBe(false);
  });

  it("rows with no transactions → false", () => {
    expect(isGridFilled([row(), row({ id: "r2" })], "EMPLOYER")).toBe(false);
  });

  it("one row with an EMPLOYER transaction → EMPLOYER filled, PERSONAL not", () => {
    const rows = [row({ transactions: [tx({ type: "EMPLOYER" })] })];
    expect(isGridFilled(rows, "EMPLOYER")).toBe(true);
    expect(isGridFilled(rows, "PERSONAL")).toBe(false);
  });

  it("only superseded transactions → not filled (they don't count)", () => {
    const rows = [
      row({
        transactions: [
          tx({ type: "EMPLOYER", supersededAt: "2026-09-07T11:00:00.000Z" }),
        ],
      }),
    ];
    expect(isGridFilled(rows, "EMPLOYER")).toBe(false);
  });
});

// ── contributionsProgress ─────────────────────────────────────────────────

describe("contributionsProgress", () => {
  it("non-Pension → { add: 0, filled: 0 } (contributions are Pension-only)", () => {
    expect(contributionsProgress([row()], "ISA")).toEqual({ add: 0, filled: 0 });
    expect(contributionsProgress([row()], "GIA")).toEqual({ add: 0, filled: 0 });
    expect(contributionsProgress([row()], null)).toEqual({ add: 0, filled: 0 });
    expect(contributionsProgress([row()], undefined)).toEqual({ add: 0, filled: 0 });
  });

  it("Pension with empty grids → adds 2 to denominator, 0 to numerator (existing cases drop)", () => {
    expect(contributionsProgress([row()], "PENSION")).toEqual({ add: 2, filled: 0 });
  });

  it("Pension with only EMPLOYER filled → 2 / 1", () => {
    const rows = [row({ transactions: [tx({ type: "EMPLOYER" })] })];
    expect(contributionsProgress(rows, "PENSION")).toEqual({ add: 2, filled: 1 });
  });

  it("Pension with both grids filled → 2 / 2 (contributes nothing to missing count)", () => {
    const rows = [
      row({
        transactions: [tx({ type: "EMPLOYER" }), tx({ id: "p", type: "PERSONAL" })],
      }),
    ];
    expect(contributionsProgress(rows, "PENSION")).toEqual({ add: 2, filled: 2 });
  });
});
