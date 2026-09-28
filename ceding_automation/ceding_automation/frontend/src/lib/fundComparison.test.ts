import { describe, it, expect } from "vitest";
import type { FundLine } from "@/hooks/useFundLines";
import {
  compareFundLine,
  evaluateGate,
  normaliseName,
  pricesAgree,
  chargesAgree,
  EDIT_FIELD_KEY,
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

// Most UK funds are quoted to the investor in pence (30,450 of 33,500 GB
// share classes in the fund master are GBX listings), so that is what a
// provider statement shows and what a CA copying it types. FE reports the
// major unit and CRM expects pounds, so a clean 100x gap is a unit problem on
// the checklist side far more often than it is a wrong figure.
describe("scale differences", () => {
  const priceNote = (row: FundLine) => field(row, "price").note;

  // The realistic direction: the statement quoted pence, the CA typed it as
  // read, and CRM wants pounds.
  it("spots a checklist price typed in pence", () => {
    const row = line({ pricePerUnit: "1376.7774", resolvedUnitPrice: "13.767774" });
    expect(field(row, "price").status).toBe("differs");
    expect(priceNote(row)).toMatch(/pence/i);
    expect(priceNote(row)).toMatch(/reference figure is the one to push/i);
  });

  it("calls out a misplaced decimal point the other way", () => {
    const row = line({ pricePerUnit: "0.13767774", resolvedUnitPrice: "13.767774" });
    expect(priceNote(row)).toMatch(/decimal point/i);
  });

  it("says nothing when a difference is not a clean 100x", () => {
    const row = line({ pricePerUnit: "3.90", resolvedUnitPrice: "4.2237" });
    expect(field(row, "price").status).toBe("differs");
    expect(priceNote(row)).toBeUndefined();
  });

  it("does not claim a scale problem when the two agree", () => {
    expect(priceNote(line())).toBeUndefined();
  });

  it("names a percent-against-fraction charge difference", () => {
    const row = line({ ocf: "0.0075", resolvedOcf: "0.75" });
    expect(field(row, "ocf").note).toMatch(/fraction/i);
  });

  it("does not divide by zero looking for a scale factor", () => {
    const row = line({ pricePerUnit: "0", resolvedUnitPrice: "4.2237" });
    expect(() => compareFundLine(row)).not.toThrow();
    expect(priceNote(row)).toBeUndefined();
  });
});

// The checklist column is editable in place on stage 6. The edit box has to
// open on what is stored, not on the formatted display, or a CA correcting
// "£1,376.7774" would be typing over a currency symbol and a thousands comma.
describe("inline editing", () => {
  it("exposes the raw stored value alongside the formatted one", () => {
    const row = line({ pricePerUnit: "1376.7774" });
    const price = field(row, "price");
    expect(price.cedingDisplay).toBe("£1,376.7774");
    expect(price.cedingRaw).toBe("1376.7774");
  });

  it("gives an empty raw value for a field the CA left blank", () => {
    expect(field(line({ ocf: null }), "ocf").cedingRaw).toBe("");
  });

  it("maps each editable field onto its fund-line column", () => {
    expect(EDIT_FIELD_KEY.fundName).toBe("fundName");
    expect(EDIT_FIELD_KEY.price).toBe("pricePerUnit");
    expect(EDIT_FIELD_KEY.ocf).toBe("ocf");
    expect(EDIT_FIELD_KEY.txCost).toBe("transactionCosts");
  });

  // Changing the identifier clears verification server-side. Offering that
  // edit here would silently re-block the send gate from a screen that looks
  // like it is just fixing a typo.
  it("offers no edit for the identifier", () => {
    const fields = compareFundLine(line()).fields.map((f) => f.field);
    expect(fields).not.toContain("isinSedolCiti");
    expect(Object.keys(EDIT_FIELD_KEY)).toHaveLength(4);
  });
});

// The valuation and the unit price BOTH go to CRM, so if they contradict
// each other the plan record contradicts itself. The usual cause is a value
// derived from a pence price while the price pushed is in pounds.
describe("valuation consistency", () => {
  const warn = (row: FundLine) => compareFundLine(row).valuationWarning;

  it("says nothing when units x price matches the value", () => {
    expect(warn(line({ numberOfUnits: "1000", pricePerUnit: "4.2237", value: "4223.70" })))
      .toBeUndefined();
  });

  it("absorbs the provider's rounding", () => {
    expect(warn(line({ numberOfUnits: "1000", pricePerUnit: "4.2237", value: "4225.00" })))
      .toBeUndefined();
  });

  // The real case: 1000 units of a fund priced at £13.66 is £13,660, but a
  // value worked out from the pence price would read £1,376,777.
  it("catches a value derived from the pence price", () => {
    const w = warn(
      line({
        numberOfUnits: "1000",
        pricePerUnit: "1376.7774",
        resolvedUnitPrice: "13.655552",
        priceSource: "LOOKUP",
        value: "1376777.40",
      }),
    );
    expect(w).toMatch(/does not match/i);
    expect(w).toMatch(/13,655\.55|13,655/);
  });

  // Which price is in force depends on the toggle, so the same row can be
  // consistent one way and not the other.
  it("checks against the price actually being pushed", () => {
    const base = {
      numberOfUnits: "100",
      pricePerUnit: "1376.7774",
      resolvedUnitPrice: "13.655552",
      value: "137677.74",
    } as Partial<FundLine>;
    expect(warn(line({ ...base, priceSource: "CEDING" }))).toBeUndefined();
    expect(warn(line({ ...base, priceSource: "LOOKUP" }))).toMatch(/does not match/i);
  });

  it("says nothing when there are no units to check against", () => {
    expect(warn(line({ numberOfUnits: null, value: "4223.70" }))).toBeUndefined();
  });

  it("says nothing when there is no value to check", () => {
    expect(warn(line({ numberOfUnits: "1000", value: null }))).toBeUndefined();
  });

  it("does not trip on a zero holding", () => {
    expect(warn(line({ numberOfUnits: "0", value: "0" }))).toBeUndefined();
  });
});
