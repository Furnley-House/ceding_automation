import { describe, it, expect } from "vitest";
import { bucketCaseflow, parseCaseflowRange, rankTeamPerformance } from "./dashboardStats";

const d = (s: string) => new Date(s);

describe("bucketCaseflow", () => {
  const starts = [d("2026-09-01T00:00:00Z"), d("2026-09-08T00:00:00Z")];
  const end = d("2026-09-15T00:00:00Z");

  it("counts opened by createdAt and completed by completedAt per bucket", () => {
    const out = bucketCaseflow(starts, end, [
      { createdAt: d("2026-09-02T10:00:00Z"), completedAt: d("2026-09-10T10:00:00Z"), closed: true },
      { createdAt: d("2026-09-09T10:00:00Z"), completedAt: null, closed: false },
      { createdAt: d("2026-08-20T10:00:00Z"), completedAt: d("2026-09-03T10:00:00Z"), closed: true },
    ]);
    expect(out.map((b) => [b.opened, b.completed])).toEqual([[1, 1], [1, 1]]);
    expect(out[0].end).toBe("2026-09-08T00:00:00.000Z");
    expect(out[1].end).toBe("2026-09-15T00:00:00.000Z");
  });

  it("ignores dates outside the range and completedAt on cases that aren't closed", () => {
    const out = bucketCaseflow(starts, end, [
      { createdAt: d("2026-09-15T00:00:00Z"), completedAt: null, closed: false }, // end is exclusive
      { createdAt: d("2026-09-02T00:00:00Z"), completedAt: d("2026-09-03T00:00:00Z"), closed: false },
    ]);
    expect(out.map((b) => [b.opened, b.completed])).toEqual([[1, 0], [0, 0]]);
  });
});

describe("parseCaseflowRange", () => {
  it("accepts ascending ISO starts plus a later end", () => {
    const r = parseCaseflowRange("2026-01-01T00:00:00Z,2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z");
    expect(r?.starts).toHaveLength(2);
  });
  it("rejects missing, unsorted, invalid or oversized input", () => {
    expect(parseCaseflowRange(undefined, "2026-03-01")).toBeNull();
    expect(parseCaseflowRange("2026-02-01,2026-01-01", "2026-03-01")).toBeNull();
    expect(parseCaseflowRange("not-a-date", "2026-03-01")).toBeNull();
    expect(parseCaseflowRange("2026-01-01", "2025-12-01")).toBeNull();
    const many = Array.from({ length: 41 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString()).join(",");
    expect(parseCaseflowRange(many, "2026-12-31")).toBeNull();
  });
});

describe("rankTeamPerformance", () => {
  const p = (userId: string, active: number, completed: number) => ({ userId, name: userId, role: "CA_TEAM", active, completed });

  it("adds totals and percentages and ranks by completion rate", () => {
    const out = rankTeamPerformance([p("a", 8, 2), p("b", 1, 9), p("c", 0, 1)]);
    expect(out.map((r) => r.userId)).toEqual(["c", "b", "a"]);
    expect(out[1]).toMatchObject({ rank: 2, total: 10, activePct: 10, completedPct: 90 });
    expect(out[2]).toMatchObject({ rank: 3, total: 10, activePct: 80, completedPct: 20 });
  });

  it("breaks rate ties on completed count, then total", () => {
    const out = rankTeamPerformance([p("a", 1, 1), p("b", 5, 5)]);
    expect(out.map((r) => r.userId)).toEqual(["b", "a"]);
  });

  it("drops people with no cases", () => {
    expect(rankTeamPerformance([p("a", 0, 0)])).toEqual([]);
  });
});
