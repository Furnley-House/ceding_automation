import { describe, it, expect, beforeEach, vi } from "vitest";

const { byRef, byName } = vi.hoisted(() => ({ byRef: vi.fn(), byName: vi.fn() }));
vi.mock("./zohoCrm", () => ({
  findPlanRecordByPolicyRef: byRef,
  findPlanRecordByName: byName,
}));

import { policyRefCandidates, resolvePlanRecord } from "./planResolution";

const plan = (id: string) => ({ id, record: { id, Name: `Plan-${id}` } });

beforeEach(() => {
  byRef.mockReset().mockResolvedValue(null);
  byName.mockReset().mockResolvedValue(null);
});

describe("policyRefCandidates", () => {
  it("splits a Task reference holding two refs (FH-2026-000230)", () => {
    expect(policyRefCandidates("8714659", "8714659 / 714126")).toEqual([
      "8714659",
      "8714659 / 714126",
      "714126",
    ]);
  });
  it("handles , ; & | and the word 'and'", () => {
    expect(policyRefCandidates("A1, B2; C3 & D4 | E5 and F6")).toEqual([
      "A1, B2; C3 & D4 | E5 and F6", "A1", "B2", "C3", "D4", "E5", "F6",
    ]);
  });
  it("ignores null / blank / duplicates", () => {
    expect(policyRefCandidates(null, "  ", "X9", undefined, " X9 ")).toEqual(["X9"]);
  });
});

describe("resolvePlanRecord", () => {
  it("prefers the case's own policy ref", async () => {
    byRef.mockImplementation(async (r: string) => (r === "8714659" ? plan("p1") : null));
    const hit = await resolvePlanRecord({ policyRefs: ["8714659", "8714659 / 714126"], planName: "Plan127724" });
    expect(hit).toMatchObject({ id: "p1", via: "policy_ref", matchedOn: "8714659" });
    expect(byName).not.toHaveBeenCalled();
  });
  it("falls back to an individual part of a combined Task reference", async () => {
    byRef.mockImplementation(async (r: string) => (r === "714126" ? plan("p2") : null));
    const hit = await resolvePlanRecord({ policyRefs: [null, "8714659 / 714126"] });
    expect(hit).toMatchObject({ id: "p2", via: "policy_ref", matchedOn: "714126" });
  });
  it("falls back to the cached plan name when no Policy_Ref matches uniquely (FH-2026-000234)", async () => {
    byName.mockImplementation(async (n: string) => (n === "Plan128019" ? plan("p3") : null));
    const hit = await resolvePlanRecord({ policyRefs: ["714126"], planName: "Plan128019" });
    expect(byRef).toHaveBeenCalledWith("714126");
    expect(hit).toMatchObject({ id: "p3", via: "plan_name", matchedOn: "Plan128019" });
  });
  it("returns null when nothing matches", async () => {
    expect(await resolvePlanRecord({ policyRefs: ["nope"], planName: null })).toBeNull();
  });
  it("propagates Zoho search errors", async () => {
    byRef.mockRejectedValue(new Error("Zoho down"));
    await expect(resolvePlanRecord({ policyRefs: ["x"] })).rejects.toThrow("Zoho down");
  });
});
