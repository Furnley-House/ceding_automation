import { describe, it, expect } from "vitest";
import { caseflowRange } from "./caseflowPeriods";

// Wednesday 8 Oct 2026, 15:00 local time.
const NOW = new Date(2026, 9, 8, 15, 0, 0);
const ymd = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

describe("caseflowRange", () => {
  it("weeks: last 5 Mondays, ending next Monday", () => {
    const r = caseflowRange("weeks", NOW);
    expect(r.starts.map(ymd)).toEqual(["2026-9-7", "2026-9-14", "2026-9-21", "2026-9-28", "2026-10-5"]);
    expect(ymd(r.end)).toBe("2026-10-12");
    expect(r.starts.every((d) => d.getDay() === 1 && d.getHours() === 0)).toBe(true);
  });

  it("lastWeek: 7 days Mon–Sun of the previous week", () => {
    const r = caseflowRange("lastWeek", NOW);
    expect(r.starts).toHaveLength(7);
    expect(ymd(r.starts[0])).toBe("2026-9-28");
    expect(ymd(r.end)).toBe("2026-10-5");
  });

  it("thisMonth: one bucket per day up to today", () => {
    const r = caseflowRange("thisMonth", NOW);
    expect(r.starts.map(ymd)).toEqual(["2026-10-1", "2026-10-2", "2026-10-3", "2026-10-4", "2026-10-5", "2026-10-6", "2026-10-7", "2026-10-8"]);
    expect(ymd(r.end)).toBe("2026-10-9");
  });

  it("thisYear: one bucket per month to the current month", () => {
    const r = caseflowRange("thisYear", NOW);
    expect(r.starts).toHaveLength(10);
    expect(ymd(r.starts[0])).toBe("2026-1-1");
    expect(ymd(r.end)).toBe("2026-11-1");
    expect(r.labels[0]).toBe("Jan");
  });

  it("gives a label and a tooltip range for every bucket", () => {
    for (const p of ["weeks", "lastWeek", "thisMonth", "thisYear"] as const) {
      const r = caseflowRange(p, NOW);
      expect(r.labels).toHaveLength(r.starts.length);
      expect(r.ranges).toHaveLength(r.starts.length);
    }
  });
});
