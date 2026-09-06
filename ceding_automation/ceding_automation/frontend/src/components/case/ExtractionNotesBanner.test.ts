// Pure-logic tests for the ExtractionNotesBanner branching. The React
// render is a thin wrapper around `computeBanner` (Alert with the
// returned title + lines) — the branching decisions are what matter,
// so unit-test the pure function and let the render be visually
// reviewed on staging. Vitest defaults to the node environment; we
// deliberately avoid a jsdom import to keep this in the fast path.

import { describe, it, expect } from "vitest";
import { computeBanner, EXTRACTION_NOTES_COPY } from "./ExtractionNotesBanner";

describe("computeBanner — no banner cases", () => {
  it("null → hidden", () => {
    expect(computeBanner(null).show).toBe(false);
  });
  it("undefined → hidden", () => {
    expect(computeBanner(undefined).show).toBe(false);
  });
  it("non-object primitive → hidden", () => {
    expect(computeBanner("something").show).toBe(false);
    expect(computeBanner(42).show).toBe(false);
  });
  it("happy-path (both failed=false) → hidden", () => {
    expect(
      computeBanner({
        provider: { failed: false, effective: { name: "Aviva", is_known_provider: true } },
        plan_type: { failed: false, effective: "Pension" },
      }).show,
    ).toBe(false);
  });
  it("missing failed flags → hidden (treated as happy-path)", () => {
    expect(computeBanner({ provider: {}, plan_type: {} }).show).toBe(false);
  });
});

describe("computeBanner — provider fallback only", () => {
  it("known provider fallback → knownFallback copy with the case's provider name", () => {
    const out = computeBanner({
      provider: {
        failed: true,
        failure_reason: "stage1_llm_parse_error",
        effective: { name: "Aviva", canonical: "Aviva", is_known_provider: true },
      },
      plan_type: { failed: false, effective: "Pension" },
    });
    expect(out.show).toBe(true);
    expect(out.title).toBe(EXTRACTION_NOTES_COPY.titleOne);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("Aviva");
    expect(out.lines[0]).toBe(EXTRACTION_NOTES_COPY.provider.knownFallback("Aviva"));
  });

  it("Unknown Provider — does NOT say 'we used Unknown Provider'; uses limited-context copy", () => {
    const out = computeBanner({
      provider: {
        failed: true,
        effective: { name: "Unknown Provider", canonical: null, is_known_provider: false },
      },
      plan_type: { failed: false, effective: "Pension" },
    });
    expect(out.show).toBe(true);
    expect(out.lines[0]).toBe(EXTRACTION_NOTES_COPY.provider.unknownFallback);
    expect(out.lines[0]).not.toContain("Unknown Provider");
  });

  it("is_known_provider=false with a name that isn't literally 'Unknown Provider' still uses limited-context copy", () => {
    const out = computeBanner({
      provider: {
        failed: true,
        effective: { name: "SomethingWeirdNotInRegistry", is_known_provider: false },
      },
      plan_type: { failed: false, effective: "Pension" },
    });
    expect(out.lines[0]).toBe(EXTRACTION_NOTES_COPY.provider.unknownFallback);
  });
});

describe("computeBanner — plan_type fallback only", () => {
  it("known plan type fallback → knownFallback copy naming the case's plan type", () => {
    const out = computeBanner({
      provider: { failed: false, effective: { name: "Aviva", is_known_provider: true } },
      plan_type: {
        failed: true,
        failure_reason: "stage2_llm_parse_error",
        effective: "Pension",
      },
    });
    expect(out.show).toBe(true);
    expect(out.title).toBe(EXTRACTION_NOTES_COPY.titleOne);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toBe(EXTRACTION_NOTES_COPY.planType.knownFallback("Pension"));
  });

  it("plan_type effective='UNKNOWN' → limited-context copy (does NOT say 'we used UNKNOWN')", () => {
    const out = computeBanner({
      provider: { failed: false, effective: { name: "Aviva", is_known_provider: true } },
      plan_type: { failed: true, effective: "UNKNOWN" },
    });
    expect(out.lines[0]).toBe(EXTRACTION_NOTES_COPY.planType.unknownFallback);
    expect(out.lines[0]).not.toContain("UNKNOWN");
  });

  it("plan_type effective=null → limited-context copy", () => {
    const out = computeBanner({
      provider: { failed: false, effective: { name: "Aviva", is_known_provider: true } },
      plan_type: { failed: true, effective: null },
    });
    expect(out.lines[0]).toBe(EXTRACTION_NOTES_COPY.planType.unknownFallback);
  });
});

describe("computeBanner — both fallbacks", () => {
  it("both failed with known values → titleBoth + two lines with names inline", () => {
    const out = computeBanner({
      provider: {
        failed: true,
        effective: { name: "Aviva", canonical: "Aviva", is_known_provider: true },
      },
      plan_type: { failed: true, effective: "Pension" },
    });
    expect(out.title).toBe(EXTRACTION_NOTES_COPY.titleBoth);
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toContain("Aviva");
    expect(out.lines[1]).toContain("Pension");
  });

  it("both failed, both unknown → titleBoth + two limited-context lines (no misleading names)", () => {
    const out = computeBanner({
      provider: {
        failed: true,
        effective: { name: "Unknown Provider", is_known_provider: false },
      },
      plan_type: { failed: true, effective: "UNKNOWN" },
    });
    expect(out.title).toBe(EXTRACTION_NOTES_COPY.titleBoth);
    expect(out.lines[0]).toBe(EXTRACTION_NOTES_COPY.provider.unknownFallback);
    expect(out.lines[1]).toBe(EXTRACTION_NOTES_COPY.planType.unknownFallback);
    expect(out.lines[0]).not.toMatch(/Unknown Provider/);
    expect(out.lines[1]).not.toMatch(/UNKNOWN/);
  });

  it("mixed: provider known-fallback, plan_type unknown", () => {
    const out = computeBanner({
      provider: {
        failed: true,
        effective: { name: "Aviva", is_known_provider: true },
      },
      plan_type: { failed: true, effective: "UNKNOWN" },
    });
    expect(out.title).toBe(EXTRACTION_NOTES_COPY.titleBoth);
    expect(out.lines[0]).toContain("Aviva");
    expect(out.lines[1]).toBe(EXTRACTION_NOTES_COPY.planType.unknownFallback);
  });
});
