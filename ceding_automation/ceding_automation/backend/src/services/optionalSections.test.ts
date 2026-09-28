import { describe, it, expect, vi } from "vitest";

vi.mock("@prisma/client", () => ({ PrismaClient: vi.fn(() => ({})) }));

import { deriveSectionState, isNotApplicableValue, isOptionalSection, isRealValue } from "./optionalSections";

describe("optional sections — value rules", () => {
  it("treats N/A spellings as not applicable", () => {
    for (const v of ["N/A", "n/a", " NA ", "na"]) expect(isNotApplicableValue(v)).toBe(true);
    for (const v of ["No", "", null, "None"]) expect(isNotApplicableValue(v)).toBe(false);
  });
  it("counts only real answers as data", () => {
    expect(isRealValue("Sustainable MultiAsset fund")).toBe(true);
    expect(isRealValue("No")).toBe(true); // "No" is a real answer, not N/A
    for (const v of [null, "", "  ", "MISSING", "N/A", "na"]) expect(isRealValue(v)).toBe(false);
  });
  it("knows the three optional sections only", () => {
    expect(isOptionalSection("With-Profit Funds")).toBe(true);
    expect(isOptionalSection("Guarantees")).toBe(true);
    expect(isOptionalSection("Protected Tax-Free Cash (Pre-A-Day)")).toBe(true);
    expect(isOptionalSection("Charges")).toBe(false);
  });
});

describe("deriveSectionState", () => {
  it("defaults OFF when nothing was chosen and no field holds data", () => {
    expect(deriveSectionState("Guarantees", undefined, [null, "", "N/A"])).toMatchObject({
      enabled: false, explicit: false, fieldCount: 3, realValueCount: 0,
    });
  });
  it("defaults ON when the AI already found data in the section", () => {
    expect(deriveSectionState("With-Profit Funds", undefined, ["Fund A", null])).toMatchObject({
      enabled: true, explicit: false, realValueCount: 1,
    });
  });
  it("an explicit choice always wins", () => {
    expect(deriveSectionState("Guarantees", false, ["Yes"]).enabled).toBe(false);
    // Switched ON but not filled in yet: stays ON (fields are blank).
    expect(deriveSectionState("Guarantees", true, [null, null])).toMatchObject({ enabled: true, explicit: true });
  });
});
