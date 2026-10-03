import { describe, it, expect } from "vitest";
import { todayUkDate, ukDatePlusDays } from "./dates";

describe("todayUkDate — UK calendar date, not UTC", () => {
  it("returns the UK date in GMT winter (UTC+0 — no shift)", () => {
    // 2026-01-15T12:00Z — UTC and London are the same date here.
    expect(todayUkDate(new Date("2026-01-15T12:00:00Z"))).toBe("2026-01-15");
  });

  it("returns the UK date in BST summer (UTC+1 — the item 9 bug window)", () => {
    // 2026-07-15T23:30Z — London is 00:30 on 2026-07-16 in BST.
    // Pre-fix: toISOString().slice(0,10) returned "2026-07-15" (UTC date).
    // Post-fix: todayUkDate returns the UK calendar date it actually is in London.
    expect(todayUkDate(new Date("2026-07-15T23:30:00Z"))).toBe("2026-07-16");
  });

  it("handles the edge at midnight UTC in winter (same date in London)", () => {
    expect(todayUkDate(new Date("2026-02-10T00:00:00Z"))).toBe("2026-02-10");
  });

  it("handles the edge at 23:30 UTC in winter (same date in London)", () => {
    expect(todayUkDate(new Date("2026-02-10T23:30:00Z"))).toBe("2026-02-10");
  });

  it("handles 23:30 UTC the day BEFORE DST begins (still GMT, same date)", () => {
    // Last Sunday of March 2026 is 2026-03-29. Before 01:00 UTC that day,
    // London is still GMT. 2026-03-28T23:30Z → London 23:30 on 2026-03-28.
    expect(todayUkDate(new Date("2026-03-28T23:30:00Z"))).toBe("2026-03-28");
  });

  it("handles 23:30 UTC on the day BST begins (BST already in effect, next day)", () => {
    // 2026-03-29T23:30Z → London 00:30 on 2026-03-30 in BST.
    expect(todayUkDate(new Date("2026-03-29T23:30:00Z"))).toBe("2026-03-30");
  });
});

describe("ukDatePlusDays — calendar arithmetic on the UK date", () => {
  it("today + 3 in winter", () => {
    expect(ukDatePlusDays(3, new Date("2026-01-15T12:00:00Z"))).toBe("2026-01-18");
  });

  it("today + 3 in BST overnight window — uses the UK date as the base", () => {
    // 2026-07-15T23:30Z → London 2026-07-16 → +3 → 2026-07-19.
    // Pre-fix pattern would have given 2026-07-18 (UTC base + 3).
    expect(ukDatePlusDays(3, new Date("2026-07-15T23:30:00Z"))).toBe("2026-07-19");
  });

  it("rolls over month boundaries", () => {
    expect(ukDatePlusDays(5, new Date("2026-01-30T12:00:00Z"))).toBe("2026-02-04");
  });

  it("rolls over year boundaries", () => {
    expect(ukDatePlusDays(2, new Date("2026-12-31T12:00:00Z"))).toBe("2027-01-02");
  });

  it("handles leap-year Feb 28 → Mar 1 (2026 is NOT a leap year)", () => {
    expect(ukDatePlusDays(1, new Date("2026-02-28T12:00:00Z"))).toBe("2026-03-01");
  });
});
