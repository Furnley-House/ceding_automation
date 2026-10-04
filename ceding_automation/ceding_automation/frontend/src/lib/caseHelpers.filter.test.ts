import { describe, it, expect } from "vitest";
import { CASE_STATUS_FILTERS, caseStatusBadge, matchesStatusFilter } from "./caseHelpers";

const cases = [
  { status: "pending_loa", current_stage: 3 },
  { status: "awaiting_documents", current_stage: 5 },
  { status: "extraction_complete", current_stage: 8 },
  { status: "in_review", current_stage: 8 },
  { status: "approved", current_stage: 9 },
  { status: "complete", current_stage: 10 },
  { status: "on_hold", current_stage: 1 },
  { status: "cancelled", current_stage: 3 },
];

describe("Cases status filter", () => {
  it("each case matches exactly the filter whose label equals its badge", () => {
    for (const c of cases) {
      const hits = CASE_STATUS_FILTERS.filter((f) => matchesStatusFilter(c, f.value));
      expect(hits.map((f) => f.label)).toEqual([caseStatusBadge(c).label]);
    }
  });
  it("legacy grouped filters still match by coarse status", () => {
    expect(matchesStatusFilter({ status: "awaiting_documents", current_stage: 5 }, "awaiting_documents")).toBe(true);
    expect(matchesStatusFilter({ status: "pending_loa", current_stage: 2 }, "awaiting_documents")).toBe(false);
  });
});
