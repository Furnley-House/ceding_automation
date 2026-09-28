import { describe, it, expect } from "vitest";
import { HoldingRag, FundValueSource, Prisma, type ChecklistFundLine } from "@prisma/client";
import {
  buildHoldingRow,
  mergeHoldings,
  holdingKey,
  ragLabel,
  readExistingHoldings,
  toFieldScale,
  HOLDINGS_SUBFORM,
} from "./holdingsSubform";

const dec = (v: string | number) => new Prisma.Decimal(v);

function fundLine(over: Partial<ChecklistFundLine> = {}): ChecklistFundLine {
  return {
    id: "l1",
    caseId: "c1",
    fundName: "Phoenix AL International Pn",
    isinSedolCiti: "GB0000026087",
    numberOfUnits: dec("500"),
    pricePerUnit: dec("31.643"),
    value: dec("15821.50"),
    ocf: dec("0.77"),
    transactionCosts: null,
    isWithProfits: false,
    resolvedIsin: "GB0000026087",
    resolvedFundName: "Phoenix AL International Pn",
    resolvedUnitPrice: dec("31.643"),
    resolvedPriceDate: new Date("2026-09-22T00:00:00Z"),
    resolvedOcf: dec("0.77"),
    resolvedTxCost: null,
    verifiedAt: new Date("2026-09-23T12:00:00Z"),
    holdingRag: HoldingRag.AMBER,
    fundNameSource: FundValueSource.LOOKUP,
    priceSource: FundValueSource.LOOKUP,
    ocfSource: FundValueSource.LOOKUP,
    txCostSource: FundValueSource.CEDING,
    ...over,
  } as unknown as ChecklistFundLine;
}

describe("buildHoldingRow", () => {
  it("maps onto the API names the subform actually has", () => {
    const row = buildHoldingRow(fundLine());
    expect(row).toMatchObject({
      security_name: "Phoenix AL International Pn",
      isin: "GB0000026087",
      position: 500,
      gbp_valuation: 31.64, // rounded to the 2dp the currency field accepts
      Holdings_Valuation: 15821.5,
      valuation_date: "2026-09-22",
      OCF: 0.77,
      RAG: "Amber",
    });
  });

  // Export must carry what the CA signed off at stage 6, not a fresh lookup.
  it("uses the checklist figure where the CA chose it", () => {
    const row = buildHoldingRow(
      fundLine({
        priceSource: FundValueSource.CEDING,
        pricePerUnit: dec("29.50"),
        resolvedUnitPrice: dec("31.643"),
      }),
    );
    expect(row.gbp_valuation).toBe(29.5);
  });

  it("uses the reference figure where the CA chose it", () => {
    const row = buildHoldingRow(
      fundLine({
        fundNameSource: FundValueSource.LOOKUP,
        fundName: "Institutional Authorised Unit Trusts",
        resolvedFundName: "Institutional Authorised Unit Trusts - Growth and Recovery Fund",
      }),
    );
    expect(row.security_name).toBe(
      "Institutional Authorised Unit Trusts - Growth and Recovery Fund",
    );
  });

  // A preference for a figure that does not exist must not blank the field.
  it("falls back to the other side when the chosen figure is empty", () => {
    const row = buildHoldingRow(
      fundLine({ ocfSource: FundValueSource.LOOKUP, resolvedOcf: null, ocf: dec("0.9") }),
    );
    expect(row.OCF).toBe(0.9);
  });

  // The builder now keeps empties, because an UPDATE has to write them to
  // clear a value the CA deleted. Whether they are sent is decided per
  // insert / update in mergeHoldings, covered below.
  it("reports a field neither side has as empty", () => {
    const row = buildHoldingRow(fundLine({ transactionCosts: null, resolvedTxCost: null }));
    expect(row.Transaction_Cost).toBeNull();
  });

  // A red holding still reaches CRM carrying what the CA typed — that is what
  // makes it fixable there.
  it("carries a red holding across with the identifier the CA typed", () => {
    const row = buildHoldingRow(
      fundLine({
        holdingRag: HoldingRag.RED,
        isinSedolCiti: "SWXBJ2",
        resolvedIsin: null,
        resolvedFundName: null,
        resolvedUnitPrice: null,
        fundNameSource: FundValueSource.CEDING,
        priceSource: FundValueSource.CEDING,
      }),
    );
    expect(row.RAG).toBe("Red");
    expect(row.isin).toBe("SWXBJ2");
    expect(row.security_name).toBe("Phoenix AL International Pn");
  });

  it("never sends the read-only Parent_Id", () => {
    expect("Parent_Id" in buildHoldingRow(fundLine())).toBe(false);
  });

  it("leaves Weighting alone, as asked", () => {
    expect("Weighting" in buildHoldingRow(fundLine())).toBe(false);
  });

  it("has no RAG for an unverified holding", () => {
    expect(ragLabel(null)).toBeNull();
    expect(buildHoldingRow(fundLine({ holdingRag: null })).RAG).toBeNull();
  });
});

describe("holdingKey", () => {
  it("prefers the ISIN", () => {
    expect(holdingKey({ isin: "gb0000026087", security_name: "X" })).toBe("isin:GB0000026087");
  });

  it("falls back to the fund name when there is no ISIN", () => {
    expect(holdingKey({ security_name: "RLS Deposit Pn." })).toBe("name:RLS DEPOSIT PN");
  });

  it("matches two spellings of the same name", () => {
    expect(holdingKey({ security_name: "RLS Deposit Pn." })).toBe(
      holdingKey({ security_name: "rls  deposit   pn" }),
    );
  });

  it("is null when there is nothing to identify the row by", () => {
    expect(holdingKey({ position: 10 })).toBeNull();
  });
});

describe("readExistingHoldings", () => {
  it("reads the rows off a Plan record", () => {
    const rows = readExistingHoldings({ [HOLDINGS_SUBFORM]: [{ id: "row-1" }] });
    expect(rows).toHaveLength(1);
  });

  it("treats a Plan with an empty subform as having none", () => {
    expect(readExistingHoldings({ [HOLDINGS_SUBFORM]: null })).toEqual([]);
    expect(readExistingHoldings({})).toEqual([]);
  });

  it("uses the subform name the module actually has", () => {
    expect(HOLDINGS_SUBFORM).toBe("Holdings_List");
  });
});

// Zoho REJECTS an over-precise number — a 400 naming the field and its
// maximum_decimal_place, not a silent truncation. FE returns prices to six
// decimals and the fund master charges to four, so every numeric field has to
// be brought down to what the subform accepts.
describe("field precision", () => {
  it("rounds a unit price to the two decimals the field allows", () => {
    const row = buildHoldingRow(fundLine({ resolvedUnitPrice: dec("13.767774") }));
    expect(row.gbp_valuation).toBe(13.77);
  });

  it("rounds the holdings valuation too", () => {
    const row = buildHoldingRow(fundLine({ value: dec("15821.5049") }));
    expect(row.Holdings_Valuation).toBe(15821.5);
  });

  it("rounds charges to two decimals", () => {
    const row = buildHoldingRow(
      fundLine({ resolvedOcf: dec("0.7699"), resolvedTxCost: dec("0.0486"), txCostSource: FundValueSource.LOOKUP }),
    );
    expect(row.OCF).toBe(0.77);
    expect(row.Transaction_Cost).toBe(0.05);
  });

  // Ex-ante transaction costs are routinely negative, and Math.round rounds
  // -0.185 towards zero, which would disagree with the positive case.
  it("rounds a negative transaction cost away from zero", () => {
    expect(toFieldScale("Transaction_Cost", -0.185)).toBe(-0.19);
    expect(toFieldScale("Transaction_Cost", 0.185)).toBe(0.19);
  });

  it("keeps units at the nine decimals that field allows", () => {
    const row = buildHoldingRow(fundLine({ numberOfUnits: dec("500.123456789") }));
    expect(row.position).toBe(500.123456789);
  });

  it("leaves a field with no stated limit alone", () => {
    expect(toFieldScale("security_name", 1.23456)).toBe(1.23456);
  });

  it("passes a null through untouched", () => {
    expect(toFieldScale("gbp_valuation", null)).toBeNull();
  });
});

// These describe the subform's MEASURED behaviour, not the documented one.
// A row with an id updates, a row without one inserts, a row not mentioned
// is left alone, and { id, _delete: null } deletes. The third of those is
// the opposite of what the usual "a PUT replaces the subform" advice says,
// and believing that advice is what made deletes silently do nothing.
describe("mergeHoldings", () => {
  const onPlan = [
    { id: "row-1", isin: "GB1", security_name: "Ours" },
    { id: "row-9", isin: "gfghh666", security_name: "gfg" }, // added by hand in CRM
  ];
  const OURS = ["isin:GB1"];

  it("updates a holding we own, by id", () => {
    const r = mergeHoldings(onPlan, [{ isin: "GB1", security_name: "Ours", OCF: 1.08 }], OURS);
    expect(r.updated).toBe(1);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ id: "row-1", security_name: "Ours", OCF: 1.08 });
  });

  // Saying nothing about a row is what leaves it alone, so a row we do not
  // own must not appear in the payload at all.
  it("says nothing at all about a row we do not own", () => {
    const r = mergeHoldings(onPlan, [{ isin: "GB1", security_name: "Ours" }], OURS);
    expect(r.kept).toBe(1);
    expect(r.rows.some((x) => x.id === "row-9")).toBe(false);
  });

  it("inserts a holding the plan does not have, with no id", () => {
    const r = mergeHoldings(onPlan, [{ isin: "GB2", security_name: "New" }], OURS);
    expect(r.added).toBe(1);
    const inserted = r.rows.find((x) => x.security_name === "New")!;
    expect(inserted).not.toHaveProperty("id");
  });

  it("never writes a field we do not own onto a row we do", () => {
    const r = mergeHoldings(
      [{ id: "row-1", isin: "GB1", Asset_Class: "Equity", Weighting: 25 }],
      [{ isin: "GB1", security_name: "Ours" }],
      OURS,
    );
    expect(r.rows[0]).not.toHaveProperty("Asset_Class");
    expect(r.rows[0]).not.toHaveProperty("Weighting");
    expect(r.rows[0]).not.toHaveProperty("Parent_Id");
  });

  it("clears a figure the CA deleted from the checklist", () => {
    const r = mergeHoldings(
      [{ id: "row-1", isin: "GB1", security_name: "Fund", OCF: 1.08 }],
      [{ isin: "GB1", security_name: "Fund" }],
      OURS,
    );
    expect(r.rows[0].OCF).toBeNull();
  });

  it("omits empty fields on a row being inserted", () => {
    const r = mergeHoldings([], [buildHoldingRow(fundLine({
      transactionCosts: null, resolvedTxCost: null, holdingRag: null,
    }))]);
    expect("Transaction_Cost" in r.rows[0]).toBe(false);
    expect("RAG" in r.rows[0]).toBe(false);
  });

  it("does not insert the same holding twice from one export", () => {
    const r = mergeHoldings([], [
      { isin: "GB1", security_name: "A" },
      { isin: "GB1", security_name: "A" },
    ]);
    expect(r.added).toBe(1);
  });

  it("skips an incoming row with nothing to identify it", () => {
    const r = mergeHoldings([], [{ position: 10 }]);
    expect(r.added).toBe(0);
    expect(r.skipped).toHaveLength(1);
  });

  it("has nothing to send when the plan is already in step", () => {
    const r = mergeHoldings([{ id: "row-9", isin: "x", security_name: "theirs" }], [], []);
    expect(r.rows).toEqual([]);
  });
});

// A holding deleted on the checklist has to leave the plan too, or the CA
// raises a ticket for an ordinary correction. The danger is deleting a row
// we did not put there, so only keys recorded on a previous successful
// export are ever touched.
describe("deleting a holding", () => {
  const onPlan = [
    { id: "row-1", isin: "GB1", security_name: "Kept Fund" },
    { id: "row-2", isin: "GB2", security_name: "Deleted Fund" },
  ];

  it("marks a row we own and no longer hold for deletion", () => {
    const r = mergeHoldings(onPlan, [{ isin: "GB1", security_name: "Kept Fund" }], [
      "isin:GB1",
      "isin:GB2",
    ]);
    expect(r.removed).toEqual(["Deleted Fund"]);
    // The explicit marker — omitting the row would leave it on the plan.
    expect(r.rows).toContainEqual({ id: "row-2", _delete: null });
  });

  it("never deletes a row this case did not put there", () => {
    const r = mergeHoldings(
      [{ id: "row-9", isin: "gfghh666", security_name: "gfg" }],
      [],
      ["isin:GB1"],
    );
    expect(r.removed).toEqual([]);
    expect(r.rows).toEqual([]);
  });

  // A case that has not exported since this shipped owns nothing yet.
  it("deletes nothing when the case has no recorded keys", () => {
    const r = mergeHoldings(onPlan, [], []);
    expect(r.removed).toEqual([]);
    expect(r.rows).toEqual([]);
  });

  it("deletes every holding when the CA has removed them all", () => {
    const r = mergeHoldings(onPlan, [], ["isin:GB1", "isin:GB2"]);
    expect(r.removed).toHaveLength(2);
    expect(r.rows).toEqual([
      { id: "row-1", _delete: null },
      { id: "row-2", _delete: null },
    ]);
  });

  it("matches a deleted holding on the fund name when it had no ISIN", () => {
    const r = mergeHoldings(
      [{ id: "row-1", security_name: "With Profits Fund" }],
      [],
      ["name:WITH PROFITS FUND"],
    );
    expect(r.removed).toEqual(["With Profits Fund"]);
  });

  it("does not delete a holding that has come back", () => {
    const r = mergeHoldings(onPlan, [{ isin: "GB2", security_name: "Deleted Fund" }], ["isin:GB2"]);
    expect(r.removed).toEqual([]);
    expect(r.updated).toBe(1);
  });

  it("reports the keys it now owns, for the next export", () => {
    const r = mergeHoldings(
      onPlan,
      [{ isin: "GB1", security_name: "Kept Fund" }, { security_name: "No ISIN Fund" }],
      ["isin:GB1", "isin:GB2"],
    );
    expect(r.ownedKeys).toEqual(["isin:GB1", "name:NO ISIN FUND"]);
  });
});
