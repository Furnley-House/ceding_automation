import { describe, it, expect } from "vitest";
import { CaseStatus } from "@prisma/client";
import { canMarkNpw, countUnresolvedConflicts, isNpwReasonCode, npwReasonText } from "./caseGuards";

const row = (o: Partial<Parameters<typeof countUnresolvedConflicts>[0][number]> = {}) => ({
  confidence: "CONFLICT",
  isManuallyOverridden: false,
  templatePlanType: "PENSION",
  sectionName: "Charges",
  ...o,
});

describe("countUnresolvedConflicts", () => {
  it("counts CONFLICT rows that weren't overridden", () => {
    expect(countUnresolvedConflicts([row(), row(), row({ confidence: "HIGH" })], "PENSION", new Set())).toBe(2);
  });
  it("ignores manually overridden rows, orphan plan-type rows and OFF sections", () => {
    const rows = [
      row({ isManuallyOverridden: true }),
      row({ templatePlanType: "ISA" }),
      row({ sectionName: "Guarantees" }),
      row(),
    ];
    expect(countUnresolvedConflicts(rows, "PENSION", new Set(["Guarantees"]))).toBe(1);
  });
});

describe("NPW helpers", () => {
  it("only in-progress cases can be marked NPW", () => {
    expect(canMarkNpw(CaseStatus.STAGE_3_CRM_SETUP)).toBe(true);
    expect(canMarkNpw(CaseStatus.ON_HOLD)).toBe(true);
    expect(canMarkNpw(CaseStatus.APPROVED)).toBe(false);
    expect(canMarkNpw(CaseStatus.STAGE_10_COMPLETE)).toBe(false);
    expect(canMarkNpw(CaseStatus.CANCELLED)).toBe(false);
  });
  it("validates reason codes and formats the stored text", () => {
    expect(isNpwReasonCode("DUPLICATE_CASE")).toBe(true);
    expect(isNpwReasonCode("toString")).toBe(false);
    expect(npwReasonText("DUPLICATE_CASE", "  ")).toBe("NPW — Duplicate case");
    expect(npwReasonText("OTHER", "Bond, not a pension")).toBe("NPW — Other: Bond, not a pension");
  });
});
