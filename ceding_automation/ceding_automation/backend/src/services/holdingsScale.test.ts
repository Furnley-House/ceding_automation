// The pence/pounds check. Its job is to be certain rather than clever: a
// false positive stops a correct export, so it fires only on a clean 100x.

import { describe, it, expect } from "vitest";
import {
  pricesAgree,
  scaleFactorBetween,
  detectPriceScaleIssues,
  describeScaleIssue,
} from "./holdingsScale";

describe("pricesAgree", () => {
  it("accepts a difference inside 0.5%", () => {
    expect(pricesAgree(1.3768, 1.38)).toBe(true);
  });

  it("rejects a difference beyond it", () => {
    expect(pricesAgree(1.3768, 1.45)).toBe(false);
  });

  // A percentage of nearly nothing is noise, so penny prices get a floor.
  it("uses an absolute floor for tiny prices", () => {
    expect(pricesAgree(0.00001, 0.00002)).toBe(true);
  });
});

describe("scaleFactorBetween", () => {
  it("spots the pence case", () => {
    expect(scaleFactorBetween(137.68, 1.3768)).toBe(0.01);
  });

  it("spots a decimal point one place too far left", () => {
    expect(scaleFactorBetween(0.013768, 1.3768)).toBe(100);
  });

  it("tolerates the two sides being priced on different days", () => {
    // 137.68p against a reference that has moved 0.3% since.
    expect(scaleFactorBetween(137.68, 1.3809)).toBe(0.01);
  });

  it("returns null for a real price difference", () => {
    expect(scaleFactorBetween(1.5, 1.3768)).toBeNull();
  });

  it("returns null for a 10x gap, which is not a currency unit", () => {
    expect(scaleFactorBetween(13.768, 1.3768)).toBeNull();
  });

  it("returns null when either side is zero", () => {
    expect(scaleFactorBetween(0, 1.3768)).toBeNull();
    expect(scaleFactorBetween(137.68, 0)).toBeNull();
  });
});

describe("detectPriceScaleIssues", () => {
  const line = (over: Record<string, unknown> = {}) => ({
    fundName: "Vanguard FTSE Global All Cap",
    priceSource: null,
    pricePerUnit: "137.68",
    resolvedUnitPrice: "1.3768",
    ...over,
  }) as Parameters<typeof detectPriceScaleIssues>[0][number];

  it("flags a checklist price that is 100x out", () => {
    const [issue] = detectPriceScaleIssues([line()]);
    expect(issue).toEqual({
      fundName: "Vanguard FTSE Global All Cap",
      checklist: 137.68,
      reference: 1.3768,
      factor: 0.01,
    });
  });

  it("flags it when the CA has explicitly chosen the checklist figure", () => {
    expect(detectPriceScaleIssues([line({ priceSource: "CEDING" })])).toHaveLength(1);
  });

  // Choosing the reference IS the fix, so there is nothing left to warn about.
  it("stays quiet when the reference figure is the one being pushed", () => {
    expect(detectPriceScaleIssues([line({ priceSource: "LOOKUP" })])).toHaveLength(0);
  });

  it("stays quiet with no reference price to compare against", () => {
    expect(detectPriceScaleIssues([line({ resolvedUnitPrice: null })])).toHaveLength(0);
  });

  it("stays quiet with no checklist price", () => {
    expect(detectPriceScaleIssues([line({ pricePerUnit: null })])).toHaveLength(0);
  });

  it("stays quiet on a genuine difference", () => {
    expect(detectPriceScaleIssues([line({ pricePerUnit: "1.50" })])).toHaveLength(0);
  });

  it("reads Prisma Decimal values, not just strings", () => {
    const decimal = { toString: () => "137.68" };
    expect(detectPriceScaleIssues([line({ pricePerUnit: decimal })])).toHaveLength(1);
  });

  it("returns one entry per affected holding", () => {
    const issues = detectPriceScaleIssues([
      line(),
      line({ fundName: "Fine Fund", pricePerUnit: "1.3768" }),
      line({ fundName: "Also Wrong" }),
    ]);
    expect(issues.map((i) => i.fundName)).toEqual([
      "Vanguard FTSE Global All Cap",
      "Also Wrong",
    ]);
  });

  it("copes with an empty list", () => {
    expect(detectPriceScaleIssues([])).toEqual([]);
  });
});

describe("describeScaleIssue", () => {
  it("names the fund, both figures and the direction", () => {
    expect(
      describeScaleIssue({
        fundName: "Vanguard FTSE Global All Cap",
        checklist: 137.68,
        reference: 1.3768,
        factor: 0.01,
      }),
    ).toBe("Vanguard FTSE Global All Cap — checklist 137.68, reference 1.3768 (100x too high)");
  });

  it("says too low for the mirror case", () => {
    expect(
      describeScaleIssue({
        fundName: "Fund",
        checklist: 0.013768,
        reference: 1.3768,
        factor: 100,
      }),
    ).toContain("100x too low");
  });
});
