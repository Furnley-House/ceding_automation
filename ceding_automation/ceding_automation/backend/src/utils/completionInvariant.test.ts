import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CaseStatus } from "@prisma/client";
import {
  checkCompletionInvariant,
  enforceCompletionInvariant,
  isCompletionGuardEnabled,
  type CompletionPrismaLike,
} from "./completionInvariant";

// DI-over-module-mocking, matching contributionsService.test.ts. Every test
// passes vi.fn stubs and asserts on both the return value and the audit
// side-effect. The pure predicate (checkCompletionInvariant) is tested
// separately from the gate (enforceCompletionInvariant) so the KI-09
// decision-(a) WHERE clause can't drift silently.

function makeMockDb(overrides?: {
  unapprovedFieldKeys?: string[];
}) {
  const findMany = vi.fn(async () =>
    (overrides?.unapprovedFieldKeys ?? []).map((fieldKey) => ({ template: { fieldKey } })),
  );
  const auditCreate = vi.fn(async () => ({}));

  const prisma = {
    checklistField: { findMany },
    auditLog: { create: auditCreate },
  } as unknown as CompletionPrismaLike;

  return { prisma, findMany, auditCreate };
}

const CASE_ID = "case-1";
const ACTOR_ID = "user-para-1";
const APPROVED = "APPROVED" as CaseStatus;
const STAGE_10 = "STAGE_10_COMPLETE" as CaseStatus;
const STAGE_8 = "STAGE_8_VERIFY_CHECKLIST" as CaseStatus;

describe("checkCompletionInvariant — WHERE clause encodes decision (a): no N/A exemption", () => {
  it("selects unapproved rows with value non-null AND non-empty (any value, including 'N/A')", async () => {
    const { prisma, findMany } = makeMockDb({ unapprovedFieldKeys: ["k1", "k2"] });

    const result = await checkCompletionInvariant(prisma, CASE_ID);

    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          caseId: CASE_ID,
          isApproved: false,
          value: { not: null },
          NOT: { value: "" },
        }),
      }),
    );
    expect(result.blocked).toBe(true);
    expect(result.unapprovedCount).toBe(2);
    expect(result.unapprovedFieldKeys).toEqual(["k1", "k2"]);
  });

  it("returns blocked=false when no rows match (case is safe to advance)", async () => {
    const { prisma } = makeMockDb({ unapprovedFieldKeys: [] });

    const result = await checkCompletionInvariant(prisma, CASE_ID);

    expect(result.blocked).toBe(false);
    expect(result.unapprovedCount).toBe(0);
    expect(result.unapprovedFieldKeys).toEqual([]);
  });
});

describe("isCompletionGuardEnabled — env flag reader", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true when COMPLETION_GUARD_ENABLED is exactly 'true'", () => {
    vi.stubEnv("COMPLETION_GUARD_ENABLED", "true");
    expect(isCompletionGuardEnabled()).toBe(true);
  });

  it("returns true when the value is 'TRUE' (case-insensitive)", () => {
    vi.stubEnv("COMPLETION_GUARD_ENABLED", "TRUE");
    expect(isCompletionGuardEnabled()).toBe(true);
  });

  it("returns false when unset", () => {
    vi.stubEnv("COMPLETION_GUARD_ENABLED", "");
    expect(isCompletionGuardEnabled()).toBe(false);
  });

  it("returns false for 'false', '1', 'yes', 'on' — only 'true' counts", () => {
    for (const v of ["false", "1", "yes", "on", "True ", " true"]) {
      vi.stubEnv("COMPLETION_GUARD_ENABLED", v);
      expect(isCompletionGuardEnabled()).toBe(false);
    }
  });
});

describe("enforceCompletionInvariant — gate behaviour by target status and flag", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // Guard OFF by default so tests match the shipped-behaviour default.
    vi.stubEnv("COMPLETION_GUARD_ENABLED", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns unblocked without hitting the DB when target is non-terminal", async () => {
    const { prisma, findMany, auditCreate } = makeMockDb({ unapprovedFieldKeys: ["k1"] });

    const result = await enforceCompletionInvariant({
      prisma,
      caseId: CASE_ID,
      targetStatus: STAGE_8,
      currentStatus: "STAGE_7_MISSING_INFO" as CaseStatus,
      actorUserId: ACTOR_ID,
    });

    expect(result.blocked).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("returns unblocked without hitting the DB on idempotent transitions (target === current)", async () => {
    const { prisma, findMany, auditCreate } = makeMockDb({ unapprovedFieldKeys: ["k1"] });

    const result = await enforceCompletionInvariant({
      prisma,
      caseId: CASE_ID,
      targetStatus: APPROVED,
      currentStatus: APPROVED,
      actorUserId: ACTOR_ID,
    });

    expect(result.blocked).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("returns unblocked (no audit) when all valued fields are approved", async () => {
    const { prisma, findMany, auditCreate } = makeMockDb({ unapprovedFieldKeys: [] });

    const result = await enforceCompletionInvariant({
      prisma,
      caseId: CASE_ID,
      targetStatus: APPROVED,
      currentStatus: STAGE_8,
      actorUserId: ACTOR_ID,
    });

    expect(result.blocked).toBe(false);
    expect(findMany).toHaveBeenCalledOnce();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("guard OFF + unapproved fields: returns blocked=false BUT emits audit (observe-only mode)", async () => {
    const { prisma, auditCreate } = makeMockDb({ unapprovedFieldKeys: ["k1", "k2", "k3"] });

    const result = await enforceCompletionInvariant({
      prisma,
      caseId: CASE_ID,
      targetStatus: STAGE_10,
      currentStatus: APPROVED,
      actorUserId: ACTOR_ID,
    });

    expect(result.blocked).toBe(false);
    expect(result.unapprovedCount).toBe(3);
    expect(result.unapprovedFieldKeys).toEqual(["k1", "k2", "k3"]);
    // Audit fires so Aruna sees the would-block count over time.
    expect(auditCreate).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "COMPLETION_BLOCKED",
          source: "SYSTEM",
          newValue: expect.stringContaining("Would block"),
          metadata: expect.objectContaining({
            targetStatus: STAGE_10,
            currentStatus: APPROVED,
            unapprovedFieldKeys: ["k1", "k2", "k3"],
            guardEnforced: false,
          }),
        }),
      }),
    );
  });

  it("guard ON + unapproved fields: returns blocked=true and audit says 'Blocked'", async () => {
    vi.stubEnv("COMPLETION_GUARD_ENABLED", "true");
    const { prisma, auditCreate } = makeMockDb({ unapprovedFieldKeys: ["k1"] });

    const result = await enforceCompletionInvariant({
      prisma,
      caseId: CASE_ID,
      targetStatus: APPROVED,
      currentStatus: STAGE_8,
      actorUserId: ACTOR_ID,
    });

    expect(result.blocked).toBe(true);
    expect(result.unapprovedCount).toBe(1);
    expect(auditCreate).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "COMPLETION_BLOCKED",
          newValue: expect.stringContaining("Blocked"),
          metadata: expect.objectContaining({ guardEnforced: true }),
        }),
      }),
    );
  });

  it("guard ON: BOTH APPROVED and STAGE_10_COMPLETE are gated (decision (b))", async () => {
    vi.stubEnv("COMPLETION_GUARD_ENABLED", "true");

    const a = makeMockDb({ unapprovedFieldKeys: ["k1"] });
    const rA = await enforceCompletionInvariant({
      prisma: a.prisma,
      caseId: CASE_ID,
      targetStatus: APPROVED,
      currentStatus: STAGE_8,
      actorUserId: ACTOR_ID,
    });
    expect(rA.blocked).toBe(true);

    const b = makeMockDb({ unapprovedFieldKeys: ["k1"] });
    const rB = await enforceCompletionInvariant({
      prisma: b.prisma,
      caseId: CASE_ID,
      targetStatus: STAGE_10,
      currentStatus: APPROVED,
      actorUserId: ACTOR_ID,
    });
    expect(rB.blocked).toBe(true);
  });
});
