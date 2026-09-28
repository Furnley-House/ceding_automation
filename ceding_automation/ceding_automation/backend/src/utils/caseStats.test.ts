import { describe, it, expect } from "vitest";
import { CaseStatus } from "@prisma/client";
import { summariseStatusCounts, medianCycleDays } from "./caseStats";

const d = (iso: string) => new Date(iso);

describe("summariseStatusCounts", () => {
  it("excludes CANCELLED from both active and completed", () => {
    const s = summariseStatusCounts([
      { status: CaseStatus.STAGE_1_LOA_PREP, count: 4 },
      { status: CaseStatus.STAGE_10_COMPLETE, count: 3 },
      { status: CaseStatus.CANCELLED, count: 2 },
    ]);
    expect(s).toMatchObject({ total: 9, active: 4, completed: 3, cancelled: 2 });
  });

  it("keeps APPROVED active — it still awaits Stage 9 Export", () => {
    const s = summariseStatusCounts([
      { status: CaseStatus.APPROVED, count: 1 },
      { status: CaseStatus.STAGE_10_COMPLETE, count: 1 },
    ]);
    expect(s).toMatchObject({ completed: 1, active: 1 });
  });

  it("counts Stage 9 and legacy IN_REVIEW as in review, and keeps them active", () => {
    const s = summariseStatusCounts([
      { status: CaseStatus.STAGE_9_ADVISER_REVIEW, count: 2 },
      { status: CaseStatus.IN_REVIEW, count: 1 },
    ]);
    expect(s).toMatchObject({ inReview: 3, active: 3 });
  });

  it("treats ON_HOLD and DRAFT as active", () => {
    const s = summariseStatusCounts([
      { status: CaseStatus.ON_HOLD, count: 1 },
      { status: CaseStatus.DRAFT, count: 1 },
    ]);
    expect(s).toMatchObject({ active: 2, onHold: 1 });
  });

  it("returns zeros for no cases", () => {
    expect(summariseStatusCounts([])).toMatchObject({ total: 0, active: 0, completed: 0 });
  });
});

describe("medianCycleDays", () => {
  it("returns null with no completed cases", () => {
    expect(medianCycleDays([])).toEqual({ medianDays: null, sampleSize: 0 });
  });

  it("takes the middle value for an odd count", () => {
    const r = medianCycleDays([
      { createdAt: d("2026-09-01"), completedAt: d("2026-09-11") }, // 10
      { createdAt: d("2026-09-01"), completedAt: d("2026-09-03") }, // 2
      { createdAt: d("2026-09-01"), completedAt: d("2026-10-01") }, // 30
    ]);
    expect(r).toEqual({ medianDays: 10, sampleSize: 3 });
  });

  it("averages the two middle values for an even count", () => {
    const r = medianCycleDays([
      { createdAt: d("2026-09-01"), completedAt: d("2026-09-03") }, // 2
      { createdAt: d("2026-09-01"), completedAt: d("2026-09-06") }, // 5
    ]);
    expect(r).toEqual({ medianDays: 3.5, sampleSize: 2 });
  });

  it("ignores missing completion dates and completion-before-creation", () => {
    const r = medianCycleDays([
      { createdAt: d("2026-09-10"), completedAt: d("2026-09-01") },
      { createdAt: d("2026-09-01"), completedAt: null },
      { createdAt: d("2026-09-01"), completedAt: d("2026-09-05") }, // 4
    ]);
    expect(r).toEqual({ medianDays: 4, sampleSize: 1 });
  });

  it("rounds to one decimal place", () => {
    const r = medianCycleDays([
      { createdAt: d("2026-09-01T00:00:00Z"), completedAt: d("2026-09-01T08:00:00Z") },
    ]);
    expect(r.medianDays).toBe(0.3);
  });
});
