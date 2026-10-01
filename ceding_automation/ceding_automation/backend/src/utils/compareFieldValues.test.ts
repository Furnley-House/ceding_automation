import { describe, it, expect } from "vitest";
import { compareFieldValues } from "./compareFieldValues";

describe("compareFieldValues", () => {
  describe("null/empty", () => {
    it("null == null", () => {
      expect(compareFieldValues(null, null)).toBe("equivalent");
    });
    it("undefined == undefined", () => {
      expect(compareFieldValues(undefined, undefined)).toBe("equivalent");
    });
    it("null vs value", () => {
      expect(compareFieldValues("Aviva", null)).toBe("different");
    });
    it("empty == None", () => {
      expect(compareFieldValues("", "None")).toBe("equivalent");
    });
    it("'N/A' == 'null' (string)", () => {
      expect(compareFieldValues("N/A", "null")).toBe("equivalent");
    });
  });

  describe("text", () => {
    it("case insensitive", () => {
      expect(compareFieldValues("Aviva", "AVIVA", "text")).toBe("equivalent");
    });
    it("whitespace normalised", () => {
      expect(compareFieldValues("Aviva  Plc", "Aviva Plc", "text")).toBe("equivalent");
    });
    it("trailing punctuation stripped", () => {
      expect(compareFieldValues("Aviva.", "Aviva", "text")).toBe("equivalent");
    });
    it("different names", () => {
      expect(compareFieldValues("Aviva", "Prudential", "text")).toBe("different");
    });
    it("none-phrase variants", () => {
      expect(compareFieldValues("None", "No regular contributions", "text")).toBe(
        "equivalent",
      );
    });
    it("prefix ≥85% tolerated", () => {
      // 18/19 chars = 0.95, above the 0.85 threshold
      expect(
        compareFieldValues("Aviva Pension Plan", "Aviva Pension Plans", "text"),
      ).toBe("equivalent");
    });
    it("prefix <85% kept as different", () => {
      expect(
        compareFieldValues(
          "Bid/Offer spread of approximately 5%",
          "Bid/Offer spread of approximately 5% between the offer price and the lower bid price.",
          "text",
        ),
      ).toBe("different");
    });
  });

  describe("currency", () => {
    it("£ vs no £", () => {
      expect(compareFieldValues("£10,558.60", "10558.60", "currency")).toBe("equivalent");
    });
    it("decimals normalised", () => {
      expect(compareFieldValues("£10558.60", "£10558.6", "currency")).toBe("equivalent");
    });
    it("comma vs no comma", () => {
      expect(compareFieldValues("£1,234.56", "£1234.56", "currency")).toBe("equivalent");
    });
    it("genuine difference", () => {
      expect(compareFieldValues("£10,558.60", "£10,414.26", "currency")).toBe("different");
    });
  });

  describe("date", () => {
    it("ISO == UK", () => {
      expect(compareFieldValues("2026-05-05", "05/05/2026", "date")).toBe("equivalent");
    });
    it("ISO with prefix", () => {
      expect(compareFieldValues("2026-05-05", "As of 2026-05-05", "date")).toBe(
        "equivalent",
      );
    });
    it("different dates", () => {
      expect(compareFieldValues("2026-05-05", "2026-03-18", "date")).toBe("different");
    });
  });

  describe("boolean / yes_no", () => {
    it("Yes / yes", () => {
      expect(compareFieldValues("Yes", "yes", "yes_no")).toBe("equivalent");
    });
    it("Y / Yes", () => {
      expect(compareFieldValues("Y", "Yes", "yes_no")).toBe("equivalent");
    });
    it("No / None", () => {
      expect(compareFieldValues("No", "None", "yes_no")).toBe("equivalent");
    });
    it("No / 0", () => {
      expect(compareFieldValues("No", "0", "yes_no")).toBe("equivalent");
    });
    it("Yes vs No", () => {
      expect(compareFieldValues("Yes", "No", "yes_no")).toBe("different");
    });
  });

  describe("percentage", () => {
    it("with vs without %", () => {
      expect(compareFieldValues("1.25%", "1.25", "percentage")).toBe("equivalent");
    });
    it("within 0.02 tolerance", () => {
      expect(compareFieldValues("1.25%", "1.26%", "percentage")).toBe("equivalent");
    });
    it("beyond tolerance", () => {
      expect(compareFieldValues("1.25%", "1.50%", "percentage")).toBe("different");
    });
  });

  describe("dropdown", () => {
    it("case-insensitive equal", () => {
      expect(compareFieldValues("Pension", "pension", "dropdown")).toBe("equivalent");
    });
    it("different options", () => {
      expect(compareFieldValues("Pension", "ISA", "dropdown")).toBe("different");
    });
  });

  describe("provider canonicalisation (Phase 2)", () => {
    it("'Aviva' vs 'Aviva Life & Pensions UK Limited' with canonical=Aviva", () => {
      expect(
        compareFieldValues(
          "Aviva",
          "Aviva Life & Pensions UK Limited",
          "text",
          "provider_name",
          { providerCanonical: "Aviva" },
        ),
      ).toBe("equivalent");
    });
    it("'Aviva' vs 'Prudential' with canonical=Aviva", () => {
      expect(
        compareFieldValues("Aviva", "Prudential", "text", "provider_name", {
          providerCanonical: "Aviva",
        }),
      ).toBe("different");
    });
    it("'Aviva' vs 'Aviva Wrap' with canonical=Aviva", () => {
      expect(
        compareFieldValues("Aviva", "Aviva Wrap", "text", "provider_name", {
          providerCanonical: "Aviva",
        }),
      ).toBe("equivalent");
    });
    it("canonical empty falls through to text", () => {
      // Without canonical, "Aviva" vs "Aviva Life & Pensions UK Limited" is too
      // different (long suffix) — neither full equality nor ≥85% prefix.
      expect(
        compareFieldValues(
          "Aviva",
          "Aviva Life & Pensions UK Limited",
          "text",
          "provider_name",
        ),
      ).toBe("different");
    });
    it("canonical only applies to provider_name fieldKey", () => {
      expect(
        compareFieldValues(
          "Aviva",
          "Aviva Life & Pensions UK Limited",
          "text",
          "some_other_field",
          { providerCanonical: "Aviva" },
        ),
      ).toBe("different");
    });
  });
});
