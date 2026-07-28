// backend/src/services/__tests__/parseCedingSubject.test.ts
// Covers the Subject-fallback introduced for Refresh-from-Zoho when the
// structured Task fields (Provider_group, Plan_reference) are missing.
//
// Real-world subjects come from screenshots and CRM samples the CA team
// shared during UAT.

import { describe, it, expect } from "vitest";
import { parseCedingSubject } from "../zohoCrm";

describe("parseCedingSubject", () => {
  it("extracts provider + policyRef from the canonical 4-part pattern", () => {
    expect(
      parseCedingSubject("Ceding - Standard Life Pension - Catherine Mundell - D2732884000"),
    ).toEqual({ provider: "Standard Life", policyRef: "D2732884000" });
  });

  it("handles a provider with no plan-type word in the segment", () => {
    // The last part is an alphanumeric code so it should be picked up as
    // policyRef. Provider stays as-is (no plan-type word to strip).
    expect(
      parseCedingSubject("Ceding - Nest - Keith Abraham - EMP2733884000"),
    ).toEqual({ provider: "Nest", policyRef: "EMP2733884000" });
  });

  it("strips multi-word plan-type suffix (Personal Pension)", () => {
    expect(
      parseCedingSubject("Ceding - Aviva Personal Pension - Eleanor Whitmore - AV-PP-55021"),
    ).toEqual({ provider: "Aviva", policyRef: "AV-PP-55021" });
  });

  it("handles GIA and ISA plan-type words", () => {
    expect(
      parseCedingSubject("Ceding - AJ Bell GIA - Sam Client - AJB123ABC"),
    ).toEqual({ provider: "AJ Bell", policyRef: "AJB123ABC" });
    expect(
      parseCedingSubject("Ceding - Vanguard ISA - Sam Client - VNG9987"),
    ).toEqual({ provider: "Vanguard", policyRef: "VNG9987" });
  });

  it("returns empty when subject doesn't start with Ceding", () => {
    expect(parseCedingSubject("Something else entirely")).toEqual({});
    expect(parseCedingSubject("Follow-up call for Mr Smith")).toEqual({});
  });

  it("returns partial result on 3-part subject (no policy ref)", () => {
    // No trailing alphanumeric code — accept the provider we can extract,
    // but leave policyRef undefined so the caller keeps its DB value.
    expect(
      parseCedingSubject("Ceding - Standard Life Pension - Catherine Mundell"),
    ).toEqual({ provider: "Standard Life" });
  });

  it("does NOT misread a client name as a policy ref", () => {
    // "Mundell" is alphanumeric but has no digits — looksLikePolicyRef
    // rejects it, so policyRef stays undefined.
    expect(
      parseCedingSubject("Ceding - Standard Life Pension - Catherine - Mundell"),
    ).toEqual({ provider: "Standard Life" });
  });

  it("is case-insensitive on the Ceding prefix", () => {
    expect(
      parseCedingSubject("ceding - Nest - Client - EMP123ABC"),
    ).toEqual({ provider: "Nest", policyRef: "EMP123ABC" });
    expect(
      parseCedingSubject("CEDING - Nest - Client - EMP123ABC"),
    ).toEqual({ provider: "Nest", policyRef: "EMP123ABC" });
  });

  it("tolerates en/em dashes as separators", () => {
    expect(
      parseCedingSubject("Ceding – Nest – Client – EMP123ABC"),
    ).toEqual({ provider: "Nest", policyRef: "EMP123ABC" });
  });
});
