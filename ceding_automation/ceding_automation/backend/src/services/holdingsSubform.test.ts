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

describe("mergeHoldings", () => {
  const existing = [
    { id: "row-1", isin: "GB0000026087", security_name: "Phoenix AL International Pn" },
    { id: "row-2", isin: "GB0000011444", security_name: "Institutional AUT" },
  ];

  // A PUT replaces the subform, so anything left out is DELETED. This is the
  // test that stops an export wiping a CA's work in CRM.
  it("echoes every existing row back with its id", () => {
    const { rows } = mergeHoldings(existing, []);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(["row-1", "row-2"]);
  });

  it("appends a holding the Plan does not have", () => {
    const incoming = [{ isin: "GB00B3ZHN960", security_name: "Vanguard LifeStrategy" }];
    const result = mergeHoldings(existing, incoming);
    expect(result.added).toBe(1);
    expect(result.kept).toBe(2);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[2]).not.toHaveProperty("id"); // new rows carry no id
  });

  // Stage 6 is where the CA settles which figure is right. An export that
  // only appends means a re-check, a source change or a corrected price never
  // reaches CRM after the first push.
  it("refreshes a holding already on the Plan, in place", () => {
    const incoming = [{ isin: "GB0000026087", security_name: "Phoenix AL International Pn", OCF: 9.9 }];
    const result = mergeHoldings(existing, incoming);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.rows).toHaveLength(2);
    // Same row — it keeps its id — carrying the new figure.
    expect(result.rows[0]).toMatchObject({ id: "row-1", OCF: 9.9 });
  });

  // Our values win on the fields we own; anything else a workflow or a
  // person put on the row survives.
  it("overlays our fields without discarding the rest of the row", () => {
    const result = mergeHoldings(
      [{ id: "row-1", isin: "GB1", security_name: "Old name", Asset_Class: "Equity", Weighting: 25 }],
      [{ isin: "GB1", security_name: "New name", OCF: 1.08 }],
    );
    expect(result.rows[0]).toMatchObject({
      id: "row-1",
      security_name: "New name",
      OCF: 1.08,
      Asset_Class: "Equity", // not ours — untouched
      Weighting: 25, // not ours — untouched
    });
  });

  // Before this, deleting a wrong OCF on the checklist made it disappear
  // from ceding and stay in CRM for ever, with nothing to say so.
  it("clears a figure the CA deleted from the checklist", () => {
    const result = mergeHoldings(
      [{ id: "row-1", isin: "GB1", security_name: "Fund", OCF: 1.08 }],
      [{ isin: "GB1", security_name: "Fund" }], // OCF gone
    );
    expect(result.rows[0].OCF).toBeNull();
  });

  // Nothing to clear on a brand new row, and a subform row full of explicit
  // nulls is noise.
  it("omits empty fields on a row being added, rather than sending nulls", () => {
    const result = mergeHoldings([], [buildHoldingRow(fundLine({
      transactionCosts: null, resolvedTxCost: null, holdingRag: null,
    }))]);
    expect("Transaction_Cost" in result.rows[0]).toBe(false);
    expect("RAG" in result.rows[0]).toBe(false);
    expect(result.rows[0].security_name).toBeTruthy();
  });

  // The manual row from the live test. Nothing to do with this case, so it is
  // passed through exactly as found.
  it("leaves a row this case does not own untouched", () => {
    const result = mergeHoldings(
      [{ id: "row-9", isin: "gfghh666", security_name: "gfg" }],
      [{ isin: "GB1", security_name: "Ours" }],
    );
    expect(result.kept).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.added).toBe(1);
    expect(result.rows[0]).toEqual({ id: "row-9", isin: "gfghh666", security_name: "gfg" });
  });

  it("matches an existing row case-insensitively on the ISIN", () => {
    const result = mergeHoldings(
      [{ id: "row-1", isin: "gb0000026087" }],
      [{ isin: "GB0000026087", security_name: "Phoenix" }],
    );
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
  });

  it("matches a row with no ISIN on the fund name", () => {
    const result = mergeHoldings(
      [{ id: "row-1", security_name: "With Profits Fund" }],
      [{ security_name: "with profits fund" }],
    );
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
  });

  // The bug this replaced: a second export left the first export's figures in
  // place, so a re-priced holding stayed stale in CRM for ever.
  it("carries a re-priced holding through on a second export", () => {
    const firstExport = mergeHoldings([], [
      { isin: "GB0000011444", security_name: "Institutional AUT", gbp_valuation: 13.77 },
    ]);
    const asStoredInCrm = firstExport.rows.map((r, i) => ({ ...r, id: `row-${i}` }));

    const secondExport = mergeHoldings(asStoredInCrm, [
      { isin: "GB0000011444", security_name: "Institutional AUT", gbp_valuation: 13.66 },
    ]);
    expect(secondExport.rows).toHaveLength(1);
    expect(secondExport.rows[0].gbp_valuation).toBe(13.66);
    expect(secondExport.rows[0].id).toBe("row-0");
  });

  it("strips the fields Zoho will not take back on an existing row", () => {
    const { rows } = mergeHoldings(
      [
        {
          id: "row-1",
          isin: "GB1",
          Parent_Id: { id: "plan-1" },
          Created_Time: "2026-01-01T00:00:00Z",
          Modified_Time: "2026-01-02T00:00:00Z",
          $approval: { approve: false },
        },
      ],
      [],
    );
    expect(rows[0]).toEqual({ id: "row-1", isin: "GB1" });
  });

  // Appending an unidentifiable row would duplicate it on every export.
  it("skips an incoming row with nothing to identify it", () => {
    const result = mergeHoldings([], [{ position: 10 }]);
    expect(result.added).toBe(0);
    expect(result.skipped).toHaveLength(1);
  });

  it("does not add the same holding twice from one export", () => {
    const result = mergeHoldings(
      [],
      [
        { isin: "GB1", security_name: "A" },
        { isin: "GB1", security_name: "A" },
      ],
    );
    expect(result.added).toBe(1);
  });

  it("handles a Plan with no subform at all", () => {
    const result = mergeHoldings([], [{ isin: "GB1", security_name: "A" }]);
    expect(result.rows).toHaveLength(1);
    expect(result.kept).toBe(0);
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
