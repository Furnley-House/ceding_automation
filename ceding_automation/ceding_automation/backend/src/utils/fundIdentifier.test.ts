import { describe, it, expect } from "vitest";
import { classifyFundIdentifier, collectLookupKeys } from "./fundIdentifier";

describe("classifyFundIdentifier", () => {
  // Values below are real shapes taken from production fund lines.
  it.each([
    ["GB00B4W9CK61", "ISIN"],
    ["GB0007832487", "ISIN"],
    ["B4W9CK6", "SEDOL"],
    ["0783248", "SEDOL"],
    ["3344114", "SEDOL"],
    ["0SVM", "CITI"],
    ["KYAD", "CITI"],
  ] as const)("classifies %s as %s", (raw, kind) => {
    expect(classifyFundIdentifier(raw).kind).toBe(kind);
  });

  it.each(["N/A", "Nil", "-", "", "   ", "TBC", "?"])(
    "treats %s as unusable",
    (raw) => {
      const r = classifyFundIdentifier(raw);
      expect(r.kind).toBe("UNUSABLE");
      expect(r.value).toBeNull();
    },
  );

  it("handles null and undefined", () => {
    expect(classifyFundIdentifier(null).kind).toBe("UNUSABLE");
    expect(classifyFundIdentifier(undefined).kind).toBe("UNUSABLE");
  });

  it("normalises case and surrounding whitespace", () => {
    const r = classifyFundIdentifier("  gb00b4w9ck61  ");
    expect(r.kind).toBe("ISIN");
    expect(r.value).toBe("GB00B4W9CK61");
    expect(r.raw).toBe("  gb00b4w9ck61  "); // raw is preserved verbatim
  });

  it("strips internal spacing, as ISINs arrive grouped from PDFs", () => {
    expect(classifyFundIdentifier("GB00 B4W9 CK61").value).toBe("GB00B4W9CK61");
  });

  it("takes the first usable code from a two-code cell", () => {
    // Real production value.
    const r = classifyFundIdentifier("SWXBJ2 / BCLXQL4");
    expect(r.kind).toBe("SEDOL");
    expect(r.value).toBe("BCLXQL4"); // SWXBJ2 is 6 chars — not a valid SEDOL
  });

  it("rejects a 7-char value containing a vowel — SEDOLs have none", () => {
    expect(classifyFundIdentifier("BAW9CK6").kind).toBe("UNUSABLE");
  });

  // ── Security: nothing with SQL wildcard or quote characters may be
  // classified as usable, because the SEDOL match compares inside a query.
  it.each(["B4W9CK%", "B4W9CK_", "GB00B4W9CK6%", "'; DROP TABLE funds;--", "%", "_"])(
    "refuses %s rather than letting it reach a query",
    (raw) => {
      expect(classifyFundIdentifier(raw).kind).toBe("UNUSABLE");
    },
  );
});

describe("collectLookupKeys", () => {
  it("splits a case's identifiers into one de-duplicated set per lookup type", () => {
    const keys = collectLookupKeys([
      "GB00B4W9CK61",
      "gb00b4w9ck61", // same ISIN, different case
      "B4W9CK6",
      "0783248",
      "0SVM",
      "N/A",
      null,
    ]);

    expect(keys.isins).toEqual(["GB00B4W9CK61"]);
    expect(keys.sedols).toEqual(["B4W9CK6", "0783248"]);
    expect(keys.citiCodes).toEqual(["0SVM"]);
  });

  it("returns empty sets when nothing is usable, so no query is run at all", () => {
    expect(collectLookupKeys(["N/A", "Nil", "-", null, undefined])).toEqual({
      isins: [],
      sedols: [],
      citiCodes: [],
    });
  });
});
