// Bulk-approves checklist fields on a case that have a value AND haven't
// been flagged for paraplanner re-review or an unresolved conflict.
// Skips (leaves unapproved):
//   - value IS NULL / empty          (never approve a blank field)
//   - reviewRequestedAt IS NOT NULL  (someone asked for another look)
//   - hasConflict = true             (extractor saw disagreeing sources)
//
// Case status flip to APPROVED is guarded by KI-09's completion invariant
// (utils/completionInvariant.ts), behind COMPLETION_GUARD_ENABLED. When the
// flag is OFF the case flips regardless — matches pre-2026-10-01 behaviour
// and the guard emits a COMPLETION_BLOCKED observe-only audit. When ON, the
// case flip is skipped if any field remains unapproved after the narrow
// approve above. Response returns the actual counts either way; caller
// derives "did case advance" from skipped === 0.

import type { PrismaClient, CaseStatus } from "@prisma/client";
import { enforceCompletionInvariant } from "./completionInvariant";

// The Prisma-like slice we depend on — narrowed so the route handler
// (real PrismaClient) and the tests (plain object with vi.fn mocks)
// both type-check without leaking Prisma's whole surface into either.
// Same pattern as ContributionsPrismaLike in contributionsService.ts.
export type ApproveAllPrismaLike = Pick<PrismaClient, "checklistField" | "case" | "auditLog">;

export interface ApproveAllArgs {
  prisma: ApproveAllPrismaLike;
  caseId: string;
  actorUserId: string;
}

export interface ApproveAllResult {
  approved: number;
  skipped: number;
  skippedFieldKeys: string[];
}

export async function approveAllChecklist(args: ApproveAllArgs): Promise<ApproveAllResult> {
  const { prisma, caseId, actorUserId } = args;

  const skippable = await prisma.checklistField.findMany({
    where: {
      caseId,
      isApproved: false,
      OR: [
        { value: null },
        { value: "" },
        { reviewRequestedAt: { not: null } },
        { hasConflict: true },
      ],
    },
    include: { template: { select: { fieldKey: true } } },
  });
  const skippedFieldKeys = skippable.map((f) => f.template.fieldKey);

  const approved = await prisma.checklistField.updateMany({
    where: {
      caseId,
      isApproved: false,
      value: { not: null },
      NOT: { value: "" },
      reviewRequestedAt: null,
      hasConflict: false,
    },
    data: { isApproved: true, approvedAt: new Date(), status: "APPROVED" },
  });

  // KI-09 guard: after the narrow approve above, are there still
  // unapproved-valued fields blocking the case → APPROVED transition?
  // Observe-only (audit fires) when flag off; blocks the case.update
  // when flag on.
  const cur = await prisma.case.findUnique({
    where: { id: caseId },
    select: { status: true },
  });
  const guard = cur
    ? await enforceCompletionInvariant({
        prisma,
        caseId,
        targetStatus: "APPROVED" as CaseStatus,
        currentStatus: cur.status,
        actorUserId,
      })
    : { blocked: false, unapprovedCount: 0, unapprovedFieldKeys: [] };

  if (!guard.blocked) {
    await prisma.case.update({
      where: { id: caseId },
      data: { status: "APPROVED", approvedAt: new Date() },
    });
  }

  await prisma.auditLog.create({
    data: {
      caseId,
      userId: actorUserId,
      action: "CASE_APPROVED",
      source: "MANUAL",
      newValue:
        skippedFieldKeys.length === 0
          ? `${approved.count} field${approved.count === 1 ? "" : "s"} approved`
          : `${approved.count} approved, ${skippedFieldKeys.length} skipped`,
      metadata: skippedFieldKeys.length > 0 ? { skippedFieldKeys } : undefined,
    },
  });

  return {
    approved: approved.count,
    skipped: skippedFieldKeys.length,
    skippedFieldKeys,
  };
}
