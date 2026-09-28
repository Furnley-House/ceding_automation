import { describe, it, expect } from "vitest";
import {
  reshapeContributionTransactionsFromWire,
  reshapeContributionTotalsFromWire,
} from "./aiBffClient";

// Pure-helper tests, no axios. Both helpers exist so the H16-load-bearing
// pull path can be exercised without mocking the HTTP client — the reshape
// is where a silent drop would happen (empty maps ← wrong wire key names,
// wrong renames, missing defaults), and this test locks that mapping in.

describe("reshapeContributionTransactionsFromWire", () => {
  it("returns [] when the wire field is missing (pre-PR-B Cosmos doc)", () => {
    expect(reshapeContributionTransactionsFromWire(undefined)).toEqual([]);
  });

  it("returns [] for an explicitly empty array (post-PR-B, no contributions on this doc)", () => {
    expect(reshapeContributionTransactionsFromWire([])).toEqual([]);
  });

  it("renames snake_case → camelCase and preserves null/undefined semantics", () => {
    const wire = [
      {
        type: "EMPLOYER" as const,
        tax_year_label: "2025/26",
        date: "2025-09-15",
        amount: 500,
        description: "Reg Pension Contribution (Employer)",
        source_page: 3,
        source_ref: "table-2",
        confidence: "HIGH" as const,
      },
      {
        // A total-without-breakdown synthetic row: no date, no page/ref,
        // no confidence. All three must survive as null on the domain side,
        // not be silently dropped or coerced to a placeholder.
        type: "PERSONAL" as const,
        tax_year_label: "2024/25",
        date: null,
        amount: 4800,
        description: "AI-extracted total, no breakdown in source",
      },
    ];
    const out = reshapeContributionTransactionsFromWire(wire);
    expect(out).toEqual([
      {
        type: "EMPLOYER",
        taxYearLabel: "2025/26",
        date: "2025-09-15",
        amount: 500,
        description: "Reg Pension Contribution (Employer)",
        sourcePage: 3,
        sourceRef: "table-2",
        confidence: "HIGH",
      },
      {
        type: "PERSONAL",
        taxYearLabel: "2024/25",
        date: null,
        amount: 4800,
        description: "AI-extracted total, no breakdown in source",
        sourcePage: null,
        sourceRef: null,
        confidence: null,
      },
    ]);
  });
});

describe("reshapeContributionTotalsFromWire", () => {
  it("returns [] when the wire field is missing", () => {
    expect(reshapeContributionTotalsFromWire(undefined)).toEqual([]);
  });

  it("renames snake_case → camelCase and preserves null AiTotals", () => {
    const wire = [
      {
        position: 1,
        tax_year_label: "2025/26",
        employer_ai_total: 5000,
        personal_ai_total: 1000,
      },
      {
        // An out-of-window year the AI legitimately couldn't populate —
        // both totals null; must survive as null, not zero. Zero would be
        // a real AI reading ("we read the document and it said £0"),
        // which is a meaningfully different claim.
        position: 4,
        tax_year_label: "2022/23",
        employer_ai_total: null,
        personal_ai_total: null,
      },
    ];
    expect(reshapeContributionTotalsFromWire(wire)).toEqual([
      { position: 1, taxYearLabel: "2025/26", employerAiTotal: 5000, personalAiTotal: 1000 },
      { position: 4, taxYearLabel: "2022/23", employerAiTotal: null, personalAiTotal: null },
    ]);
  });
});
