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
    // Possessive-apostrophe collapse — "St James's Place" was coming back
    // as "different" from "St James Place" because the 85% prefix rule
    // can't bridge the "'s" split. Added so provider-name mismatch flagging
    // doesn't fire false positives on St James's Place policy documents.
    it("ASCII possessive 's folds — St James's Place ≡ St James Place", () => {
      expect(
        compareFieldValues("St James's Place", "St James Place", "text"),
      ).toBe("equivalent");
    });
    it("curly ’s possessive folds — St James’s Place ≡ St James Place", () => {
      expect(
        compareFieldValues("St James’s Place", "St James Place", "text"),
      ).toBe("equivalent");
    });
    it("case-insensitive with possessive — ST JAMES'S PLACE ≡ st james place", () => {
      expect(
        compareFieldValues("ST JAMES'S PLACE", "st james place", "text"),
      ).toBe("equivalent");
    });
    it("plural possessive (apostrophe-only) folds — Customers' Trust ≡ Customers Trust", () => {
      expect(
        compareFieldValues("Customers' Trust", "Customers Trust", "text"),
      ).toBe("equivalent");
    });
    it("possessive stripping does NOT eat trailing letters without apostrophe — glass ≠ glas", () => {
      expect(compareFieldValues("glass", "glas", "text")).toBe("different");
    });
  });

  // Provider-name alias rules — stopgap for the alias registry (KI-19).
  // All three rules are scoped to fieldKey === "provider_name" so other
  // text fields keep the stricter comparator. Each test here has a mirror
  // "same strings without the provider_name fieldKey" negative test, to
  // confirm the rule doesn't leak into general text comparison.
  describe("provider_name alias collapse (scoped to fieldKey)", () => {
    it("substring collapse — Aegon ≡ Aegon Platform (parent/subsidiary)", () => {
      expect(
        compareFieldValues("Aegon", "Aegon Platform", "text", "provider_name"),
      ).toBe("equivalent");
      // NEGATIVE: without provider_name fieldKey, substring collapse must NOT
      // fire — would over-collapse other text fields.
      expect(
        compareFieldValues("Aegon", "Aegon Platform", "text"),
      ).toBe("different");
    });
    it("substring collapse — Scottish Widows ≡ Scottish Widows Limited", () => {
      expect(
        compareFieldValues("Scottish Widows", "Scottish Widows Limited", "text", "provider_name"),
      ).toBe("equivalent");
    });
    it("substring collapse — Octopus Investments Ltd ≡ Octopus", () => {
      expect(
        compareFieldValues("Octopus Investments Ltd", "Octopus", "text", "provider_name"),
      ).toBe("equivalent");
    });
    it("'and' ↔ '&' alias — Legal & General ≡ Legal and General", () => {
      expect(
        compareFieldValues("Legal & General", "Legal and General", "text", "provider_name"),
      ).toBe("equivalent");
      // NEGATIVE: without provider_name fieldKey, "&" is preserved verbatim
      // by normalizeText and the comparator returns "different".
      expect(
        compareFieldValues("Legal & General", "Legal and General", "text"),
      ).toBe("different");
    });
    it("'and' ↔ '&' + substring — Legal and General ≡ Legal & General Assurance Society Limited", () => {
      expect(
        compareFieldValues(
          "Legal and General",
          "Legal & General Assurance Society Limited",
          "text",
          "provider_name",
        ),
      ).toBe("equivalent");
    });
    it("mid-string period strip — St. James's Place ≡ St James's Place", () => {
      expect(
        compareFieldValues("St. James's Place", "St James's Place", "text", "provider_name"),
      ).toBe("equivalent");
      // NEGATIVE: without provider_name fieldKey, inner period survives.
      expect(
        compareFieldValues("St. James's Place", "St James's Place", "text"),
      ).toBe("different");
    });
    it("period + possessive + substring — St James Place ≡ St. James's Place Wealth Management", () => {
      expect(
        compareFieldValues(
          "St James Place",
          "St. James's Place Wealth Management",
          "text",
          "provider_name",
        ),
      ).toBe("equivalent");
    });
    it("canonical-contains-both — Aegon Platform ≡ Aegon One Retirement with canonical=Aegon", () => {
      expect(
        compareFieldValues(
          "Aegon Platform",
          "Aegon One Retirement",
          "text",
          "provider_name",
          { providerCanonical: "Aegon" },
        ),
      ).toBe("equivalent");
    });
    it("genuinely different providers still flag — Scottish Widows ≠ Halifax Financial Services", () => {
      expect(
        compareFieldValues(
          "Scottish Widows",
          "Halifax Financial Services",
          "text",
          "provider_name",
        ),
      ).toBe("different");
    });
    it("People's Pension typo variants still flag (intentional — Case has typo)", () => {
      // "Peoples Pension" (Case typo) vs "The People's Pension" (correct) —
      // user chose to keep these flagging because a CA correcting the Case
      // header is useful signal. normalizeProviderName strips the "'s" so
      // this becomes "peoples pension" vs "the people pension" — neither
      // contains the other, substring fails, falls through to text diff.
      expect(
        compareFieldValues(
          "Peoples Pension",
          "The People's Pension",
          "text",
          "provider_name",
        ),
      ).toBe("different");
    });
    it("True Potential word rearrangement still flags (intentional — Case has data issue)", () => {
      expect(
        compareFieldValues(
          "True Potential Investments",
          "True Investment Potential trustee company limited",
          "text",
          "provider_name",
        ),
      ).toBe("different");
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
    it("Aviva vs Aviva Life & Pensions UK Limited collapses via substring (no canonical needed)", () => {
      // Updated 2026-10-01: used to require an explicit canonical because the
      // 85% prefix rule couldn't bridge the long suffix. The provider_name
      // substring-collapse rule now folds this pair directly — "aviva" is a
      // substring of "aviva life and pensions uk limited" after
      // normalizeProviderName. Canonical is now a fallback for the
      // "both-contain-same-base" case (Aegon Platform / Aegon One Retirement),
      // not the primary matcher. See KI-19.
      expect(
        compareFieldValues(
          "Aviva",
          "Aviva Life & Pensions UK Limited",
          "text",
          "provider_name",
        ),
      ).toBe("equivalent");
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
