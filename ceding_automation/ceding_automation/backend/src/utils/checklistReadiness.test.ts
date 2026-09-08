import { describe, it, expect } from "vitest";
import { canMarkMissingAsNA } from "./checklistReadiness";

describe("canMarkMissingAsNA", () => {
  it("returns true for a seeded case (planType + fields), even with null extractionSubmittedAt", () => {
    // Regression: FH-2026-000124 shape — pre-H23 case with 71 seeded
    // rows and a completed extraction, but no extractionSubmittedAt
    // (column postdates the case). The old guard 409'd this; the new
    // predicate says "yes, mark N/A".
    expect(canMarkMissingAsNA({ planType: "PENSION", checklistFieldCount: 71 })).toBe(true);
  });

  it("returns false when planType is null (stage 1-3 case, no committed type)", () => {
    expect(canMarkMissingAsNA({ planType: null, checklistFieldCount: 71 })).toBe(false);
  });

  it("returns false when planType is undefined", () => {
    expect(canMarkMissingAsNA({ planType: undefined, checklistFieldCount: 71 })).toBe(false);
  });

  it("returns false when planType is an empty / whitespace string", () => {
    expect(canMarkMissingAsNA({ planType: "", checklistFieldCount: 71 })).toBe(false);
    expect(canMarkMissingAsNA({ planType: "   ", checklistFieldCount: 71 })).toBe(false);
  });

  it("returns false when the case has zero seeded fields", () => {
    expect(canMarkMissingAsNA({ planType: "PENSION", checklistFieldCount: 0 })).toBe(false);
  });

  it("returns true for any positive field count with a real planType", () => {
    expect(canMarkMissingAsNA({ planType: "ISA", checklistFieldCount: 1 })).toBe(true);
    expect(canMarkMissingAsNA({ planType: "GIA", checklistFieldCount: 34 })).toBe(true);
  });
});
