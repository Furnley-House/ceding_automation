import { describe, it, expect } from "vitest";
import { shouldClearApproval } from "./approvalOnEdit";

describe("shouldClearApproval", () => {
  it("clears when an approved value is changed", () => {
    expect(shouldClearApproval(true, "Yes", "No")).toBe(true);
  });
  it("clears when an approved value is blanked", () => {
    expect(shouldClearApproval(true, "Yes", null)).toBe(true);
  });
  it("keeps approval when the value is re-saved unchanged (whitespace aside)", () => {
    expect(shouldClearApproval(true, "£1,000", " £1,000 ")).toBe(false);
  });
  it("keeps approval when the request doesn't touch the value", () => {
    expect(shouldClearApproval(true, "Yes", undefined)).toBe(false);
  });
  it("never applies to fields that aren't approved", () => {
    expect(shouldClearApproval(false, "Yes", "No")).toBe(false);
  });
});
