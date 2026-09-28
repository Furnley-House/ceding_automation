import { describe, it, expect } from "vitest";
import { isNotApplicableValue, isRealValue } from "./optionalSections";

describe("optional-section value rules (client mirror)", () => {
  it("matches the backend: N/A spellings are not answers", () => {
    for (const v of ["N/A", "n/a", " NA "]) expect(isNotApplicableValue(v)).toBe(true);
    for (const v of [null, "", "MISSING", "N/A"]) expect(isRealValue(v)).toBe(false);
  });
  it("'No' and free text are real answers", () => {
    expect(isRealValue("No")).toBe(true);
    expect(isRealValue("Fund A")).toBe(true);
  });
});
