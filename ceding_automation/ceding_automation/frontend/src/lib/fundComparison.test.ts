import { describe, it, expect } from "vitest";
import type { FundLine } from "@/hooks/useFundLines";
import {
  compareFundLine,
  evaluateGate,
  normaliseName,
  pricesAgree,
  chargesAgree,
} from "./fundComparison";

// Shaped from live rows (Sept 2026). Only the fields the comparison reads
// are meaningful; the rest satisfy the type.
function line(over: Partial<FundLine> = {}): FundLine {
  return {
    id: "l1",
    caseId: "c1",
    fundName: "Aviva Pen My Future Focus Growth Pn",
    isinSedolCiti: "GB00B4W9CK61",
    numberOfUnits: "1000",
    pricePerUnit: "4.2237",
    value: "4223.70",
    ocf: "0.75",
    transactionCosts: "0.09",
    isWithProfits: false,
    sourceDocumentId: null,
    sourcePageNumber: null,
    sourceQuote: null,
    displayOrder: 0,
    status: "extracted",
    confidence: "high",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    resolvedIsin: "GB00B4W9CK61",
    resolvedFundName: "Aviva Pen My Future Focus Growth Pn",
    resolvedUnitPrice: "4.2237",
    resolvedPriceDate: "2026-09-22",
    resolvedOcf: null,
    resolvedTxCost: null,
    verifiedAt: "2026-09-22T10:00:00Z",
    holdingRag: "AMBER",
    fundNameSource: "LOOKUP",
    priceSource: "LOOKUP",
    ocfSource: "CEDING",
    txCostSource: "CEDING",
    ...over,
  } as FundLine;
}

const field = (row: FundLine, name: string) =>
  compareFundLine(row).fields.find((f) => f.field === name)!;

describe("normaliseName", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normaliseName("RLS Deposit Pn.")).toBe(normaliseName("rls  deposit   pn"));
  });

  it("keeps genuinely different names apart", () => {
    expect(normaliseName("Aviva Growth")).not.toBe(normaliseName("Aviva Balanced"));
  });
});

describe("pricesAgree", () => {
  // The two sides are rarely priced on the same day, so small drift is
  // expected and must not read as a disagreement.
  it("tolerates drift under half a percent", () => {
    expect(pricesAgree(4.2237, 4.21)).toBe(true); // 0.33% apart
  });

  it("does not tolerate drift over half a percent", () => {
    expect(pricesAgree(4.2237, 4.2)).toBe(false); // 0.56% apart
  });

  it("flags a difference that would move the holding's value", () => {
    expect(pricesAgree(4.2237, 3.9)).toBe(false);
  });

  it("does not divide by zero on a zero reference price", () => {
    expect(pricesAgree(0, 0)).toBe(true);
    expect(pricesAgree(1, 0)).toBe(false);
  });

  // A decimal-point slip is exactly what this screen exists to catch.
  it("flags a 100x scale error", () => {
    expect(pricesAgree(422.37, 4.2237)).toBe(false);
  });
});

describe("chargesAgree", () => {
  it("absorbs trailing-zero rounding", () => {
    expect(chargesAgree(0.75, 0.75)).toBe(true);
    expect(chargesAgree(0.75, 0.7501)).toBe(true);
  });

  it("flags a real difference in the OCF", () => {
    expect(chargesAgree(0.75, 0.82)).toBe(false);
  });
});

describe("compareFundLine", () => {
  it("matches when both sides agree", () => {
    const cmp = compareFundLine(line());
    expect(cmp.hasDisagreement).toBe(false);
    expect(field(line(), "price").status).toBe("match");
  });

  it("flags a price the reference data disputes", () => {
    const row = line({ pricePerUnit: "3.90" });
    const cmp = compareFundLine(row);
    expect(cmp.hasDisagreement).toBe(true);
    const price = field(row, "price");
    expect(price.status).toBe("differs");
    expect(price.needsChoice).toBe(true);
  });

  // Charges are absent from both sources for insured pension share classes.
  // That is the normal case, not a disagreement, and must not demand a choice.
  it("does not ask for a choice when only the checklist has the OCF", () => {
    const ocf = field(line(), "ocf");
    expect(ocf.status).toBe("ceding-only");
    expect(ocf.chosen).toBe("CEDING");
    expect(ocf.needsChoice).toBe(false);
    expect(ocf.lockedReason).toBeTruthy();
  });

  it("does not ask for a choice when only the reference has a price", () => {
    const price = field(line({ pricePerUnit: null }), "price");
    expect(price.status).toBe("lookup-only");
    expect(price.chosen).toBe("LOOKUP");
    expect(price.needsChoice).toBe(false);
  });

  it("locks a field neither side could supply", () => {
    const tx = field(line({ transactionCosts: null, resolvedTxCost: null }), "txCost");
    expect(tx.status).toBe("neither");
    expect(tx.needsChoice).toBe(false);
  });

  it("honours an override the CA has already recorded", () => {
    const row = line({ pricePerUnit: "3.90", priceSource: "CEDING" });
    expect(field(row, "price").chosen).toBe("CEDING");
  });

  it("treats a cosmetic name difference as a match", () => {
    const row = line({ fundName: "aviva pen my future focus growth pn." });
    expect(field(row, "fundName").status).toBe("match");
  });

  it("flags a name that resolved to a different fund", () => {
    const row = line({ resolvedFundName: "Aviva Pen My Future Focus Cautious Pn" });
    expect(field(row, "fundName").status).toBe("differs");
    expect(compareFundLine(row).hasDisagreement).toBe(true);
  });

  it("reports an unverified row as unverified", () => {
    expect(compareFundLine(line({ verifiedAt: null })).verified).toBe(false);
  });
});

describe("evaluateGate", () => {
  it("passes a case with no holdings — there is nothing to check", () => {
    const gate = evaluateGate([]);
    expect(gate.satisfied).toBe(true);
    expect(gate.total).toBe(0);
  });

  it("blocks while any holding is unverified", () => {
    const gate = evaluateGate([line(), line({ id: "l2", verifiedAt: null })]);
    expect(gate.satisfied).toBe(false);
    expect(gate.unverified).toBe(1);
  });

  it("passes once every holding has been checked", () => {
    expect(evaluateGate([line(), line({ id: "l2" })]).satisfied).toBe(true);
  });

  // A disagreement is the CA's call to make, not a blocker: they pick a side
  // and the case moves on carrying the figure they chose.
  it("does not block on a disagreement the CA has seen", () => {
    const gate = evaluateGate([line({ pricePerUnit: "3.90" })]);
    expect(gate.satisfied).toBe(true);
    expect(gate.disagreements).toBe(1);
  });

  // RED means the reference data could not name or price it. The CA's own
  // figures stand, so it must not trap the case at stage 6.
  it("does not block on a red holding", () => {
    const red = line({
      holdingRag: "RED",
      resolvedIsin: null,
      resolvedFundName: null,
      resolvedUnitPrice: null,
      fundNameSource: "CEDING",
      priceSource: "CEDING",
    });
    expect(evaluateGate([red]).satisfied).toBe(true);
  });
});
