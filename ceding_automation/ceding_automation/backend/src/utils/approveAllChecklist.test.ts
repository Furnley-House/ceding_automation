import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { approveAllChecklist, type ApproveAllPrismaLike } from "./approveAllChecklist";

// DI-over-module-mocking, matching contributionsService.test.ts. The helper
// accepts a Prisma-like slice; tests pass vi.fn stubs and assert on the
// call args to verify the WHERE clauses that hit the database. Those
// clauses are the four skip conditions that must not silently drift back —
// see the header comment on approveAllChecklist.ts for context.

function makeMockDb(overrides?: {
  skippableFieldKeys?: string[];
  approvedCount?: number;
  currentStatus?: string | null; // null → case.findUnique returns null → guard bypassed
}) {
  const findMany = vi.fn(async () =>
    (overrides?.skippableFieldKeys ?? []).map((fieldKey) => ({ template: { fieldKey } }))
  );
  const updateMany = vi.fn(async () => ({ count: overrides?.approvedCount ?? 0 }));
  const caseFindUnique = vi.fn(async () =>
    overrides?.currentStatus === undefined || overrides?.currentStatus === null
      ? null
      : { status: overrides.currentStatus },
  );
  const caseUpdate = vi.fn(async () => ({}));
  const auditCreate = vi.fn(async () => ({}));

  const prisma = {
    checklistField: { findMany, updateMany },
    case: { findUnique: caseFindUnique, update: caseUpdate },
    auditLog: { create: auditCreate },
  } as unknown as ApproveAllPrismaLike;

  return { prisma, findMany, updateMany, caseFindUnique, caseUpdate, auditCreate };
}

// Existing tests default currentStatus to null → case.findUnique returns
// null → enforceCompletionInvariant is bypassed. Preserves the pre-guard
// behaviour these tests assert. New tests targeting the guard set
// currentStatus explicitly.

const CASE_ID = "case-1";
const ACTOR_ID = "user-para-1";

describe("approveAllChecklist — skip conditions", () => {
  it("findMany WHERE names all four skip shapes (value null, value '', reviewRequestedAt set, hasConflict true)", async () => {
    const { prisma, findMany } = makeMockDb();

    await approveAllChecklist({ prisma, caseId: CASE_ID, actorUserId: ACTOR_ID });

    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          caseId: CASE_ID,
          isApproved: false,
          OR: [
            { value: null },
            { value: "" },
            { reviewRequestedAt: { not: null } },
            { hasConflict: true },
          ],
        }),
      })
    );
  });

  it("updateMany WHERE requires value non-null, non-empty, no review flag, no conflict", async () => {
    const { prisma, updateMany } = makeMockDb();

    await approveAllChecklist({ prisma, caseId: CASE_ID, actorUserId: ACTOR_ID });

    expect(updateMany).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          caseId: CASE_ID,
          isApproved: false,
          value: { not: null },
          NOT: { value: "" },
          reviewRequestedAt: null,
          hasConflict: false,
        }),
        data: expect.objectContaining({ isApproved: true, status: "APPROVED" }),
      })
    );
  });

  it("case.update flips status to APPROVED regardless of skip count (deferred workflow decision)", async () => {
    // Even when many fields are skipped, the case still advances to APPROVED
    // today. This is the interim state — the terminal-status guard that would
    // block this is held pending an Aruna decision. See commit body.
    const { prisma, caseUpdate } = makeMockDb({
      skippableFieldKeys: ["f1", "f2", "f3", "f4", "f5"],
      approvedCount: 0,
    });

    await approveAllChecklist({ prisma, caseId: CASE_ID, actorUserId: ACTOR_ID });

    expect(caseUpdate).toHaveBeenCalledOnce();
    expect(caseUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CASE_ID },
        data: expect.objectContaining({ status: "APPROVED" }),
      })
    );
  });
});

describe("approveAllChecklist — response and audit shape", () => {
  it("returns approved + skipped counts and the fieldKeys list", async () => {
    const { prisma } = makeMockDb({
      skippableFieldKeys: ["employer_ni_number", "policy_start_date"],
      approvedCount: 42,
    });

    const result = await approveAllChecklist({ prisma, caseId: CASE_ID, actorUserId: ACTOR_ID });

    expect(result).toEqual({
      approved: 42,
      skipped: 2,
      skippedFieldKeys: ["employer_ni_number", "policy_start_date"],
    });
  });

  it("audit newValue is honest when nothing was skipped", async () => {
    const { prisma, auditCreate } = makeMockDb({ approvedCount: 40 });

    await approveAllChecklist({ prisma, caseId: CASE_ID, actorUserId: ACTOR_ID });

    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "CASE_APPROVED",
          newValue: "40 fields approved",
        }),
      })
    );
    // metadata is undefined when nothing was skipped — asserted negatively
    // via not-called-with rather than peeking into mock.calls (which loses
    // its element type through the ApproveAllPrismaLike cast).
    expect(auditCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ metadata: expect.anything() }),
      })
    );
  });

  it("audit newValue and metadata name the skipped fields when any are skipped", async () => {
    const { prisma, auditCreate } = makeMockDb({
      skippableFieldKeys: ["policy_start_date", "employer_ni_number"],
      approvedCount: 40,
    });

    await approveAllChecklist({ prisma, caseId: CASE_ID, actorUserId: ACTOR_ID });

    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "CASE_APPROVED",
          newValue: "40 approved, 2 skipped",
          metadata: { skippedFieldKeys: ["policy_start_date", "employer_ni_number"] },
        }),
      })
    );
  });

  it("singular vs plural in newValue for one field", async () => {
    const { prisma, auditCreate } = makeMockDb({ approvedCount: 1 });

    await approveAllChecklist({ prisma, caseId: CASE_ID, actorUserId: ACTOR_ID });

    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ newValue: "1 field approved" }),
      })
    );
  });

  it("handles the everything-already-approved shape (approved=0, skipped=0)", async () => {
    // No skippable rows returned, updateMany matches zero unapproved rows.
    // Case still flips to APPROVED (idempotent), audit still writes.
    const { prisma, caseUpdate, auditCreate } = makeMockDb({ approvedCount: 0 });

    const result = await approveAllChecklist({ prisma, caseId: CASE_ID, actorUserId: ACTOR_ID });

    expect(result).toEqual({ approved: 0, skipped: 0, skippedFieldKeys: [] });
    expect(caseUpdate).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ newValue: "0 fields approved" }),
      })
    );
  });
});

describe("approveAllChecklist — KI-09 guard integration", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("guard OFF (default): case still flips to APPROVED even when unapproved-valued fields remain — interim state", async () => {
    // Simulates the current shipped default: guard emits an observability
    // audit but doesn't block. Behaviour identical to pre-2026-10-01.
    vi.stubEnv("COMPLETION_GUARD_ENABLED", "");
    const { prisma, caseUpdate, auditCreate } = makeMockDb({
      skippableFieldKeys: ["review_me"],
      approvedCount: 40,
      currentStatus: "STAGE_8_VERIFY_CHECKLIST",
    });

    await approveAllChecklist({ prisma, caseId: CASE_ID, actorUserId: ACTOR_ID });

    // case.update DID fire — guard didn't block.
    expect(caseUpdate).toHaveBeenCalledOnce();
    // Two audit rows: one COMPLETION_BLOCKED (observe-only), one CASE_APPROVED.
    expect(auditCreate).toHaveBeenCalledTimes(2);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "COMPLETION_BLOCKED",
          metadata: expect.objectContaining({ guardEnforced: false }),
        }),
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "CASE_APPROVED" }),
      }),
    );
  });

  it("guard ON + unapproved fields remain: case status flip is SKIPPED", async () => {
    // The invariant fires: case stays at STAGE_8_VERIFY_CHECKLIST, fields
    // that could be approved are, but the case is NOT marked APPROVED.
    vi.stubEnv("COMPLETION_GUARD_ENABLED", "true");
    const { prisma, caseUpdate, auditCreate } = makeMockDb({
      skippableFieldKeys: ["review_me", "conflict_me"],
      approvedCount: 40,
      currentStatus: "STAGE_8_VERIFY_CHECKLIST",
    });

    const result = await approveAllChecklist({ prisma, caseId: CASE_ID, actorUserId: ACTOR_ID });

    // Fields approved as usual; case status flip skipped.
    expect(result.approved).toBe(40);
    expect(result.skipped).toBe(2);
    expect(caseUpdate).not.toHaveBeenCalled();
    // COMPLETION_BLOCKED audit reflects the enforced guard.
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "COMPLETION_BLOCKED",
          metadata: expect.objectContaining({ guardEnforced: true }),
        }),
      }),
    );
  });

  it("guard ON + all fields safely approved: case status flip proceeds normally", async () => {
    vi.stubEnv("COMPLETION_GUARD_ENABLED", "true");
    const { prisma, caseUpdate, auditCreate } = makeMockDb({
      skippableFieldKeys: [], // nothing to skip
      approvedCount: 71,
      currentStatus: "STAGE_8_VERIFY_CHECKLIST",
    });

    await approveAllChecklist({ prisma, caseId: CASE_ID, actorUserId: ACTOR_ID });

    // No unapproved-with-value fields → guard doesn't fire audit, case.update fires.
    expect(caseUpdate).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "CASE_APPROVED" }),
      }),
    );
  });
});
