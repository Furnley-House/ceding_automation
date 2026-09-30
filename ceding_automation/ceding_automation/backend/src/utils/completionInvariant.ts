// KI-09 completion-gap guard.
//
// Invariant: a case cannot enter APPROVED or STAGE_10_COMPLETE while any
// checklist field has a value AND isn't approved. Nishant's design decisions
// (locked 2026-09-29, reaffirmed 2026-10-01):
//   (a) Do NOT exempt value = "N/A" — bulk "Mark all missing as N/A" is
//       exactly the workaround this guard should catch.
//   (b) Gate both APPROVED and STAGE_10_COMPLETE — closes the "set APPROVED
//       first, then STAGE_10 second" loophole.
//   (c) Ignore showIf template rules — a DB row with a value is a field the
//       CA populated; it should be reviewed regardless of frontend
//       visibility. Backend stays a cheap COUNT/findMany; no template-aware
//       complexity.
//
// Behind COMPLETION_GUARD_ENABLED — off by default. When off the invariant
// still runs and emits a COMPLETION_BLOCKED audit row for every would-be-
// blocked transition, so Aruna has live "how often would this fire" data
// before flipping the flag on. When on, the audit still fires and the
// caller receives blocked=true.

import type { PrismaClient, CaseStatus } from "@prisma/client";

// Env-var gate. Reads at call time, not module load, so a Container App
// env update takes effect on the next request without a redeploy.
export function isCompletionGuardEnabled(): boolean {
  return String(process.env.COMPLETION_GUARD_ENABLED ?? "").toLowerCase() === "true";
}

// Terminal statuses the guard protects. Extending the list only requires
// adding an entry here — no caller-site changes.
const TERMINAL_STATUSES: readonly CaseStatus[] = [
  "APPROVED" as CaseStatus,
  "STAGE_10_COMPLETE" as CaseStatus,
];

export type CompletionPrismaLike = Pick<PrismaClient, "checklistField" | "auditLog">;

export interface CompletionCheckResult {
  blocked: boolean;
  unapprovedCount: number;
  unapprovedFieldKeys: string[];
}

export interface EnforceArgs {
  prisma: CompletionPrismaLike;
  caseId: string;
  targetStatus: CaseStatus;
  currentStatus: CaseStatus;
  actorUserId: string;
}

// Pure predicate — reads the DB, returns the count. Doesn't decide policy.
// Extracted for direct testing so the WHERE clause (which encodes decision
// (a) — no N/A exemption) can't drift silently.
export async function checkCompletionInvariant(
  prisma: CompletionPrismaLike,
  caseId: string,
): Promise<CompletionCheckResult> {
  const unapproved = await prisma.checklistField.findMany({
    where: {
      caseId,
      isApproved: false,
      value: { not: null },
      NOT: { value: "" },
    },
    include: { template: { select: { fieldKey: true } } },
  });
  const unapprovedFieldKeys = unapproved.map((f) => f.template.fieldKey);
  return {
    blocked: unapproved.length > 0,
    unapprovedCount: unapproved.length,
    unapprovedFieldKeys,
  };
}

// Gate wrapper called at each transition site. Handles:
//   - non-terminal targets → no check, return unblocked
//   - idempotent (target === current) → no check, return unblocked
//   - unapproved-fields exist → emit audit ALWAYS (observability), return
//     blocked=true only when COMPLETION_GUARD_ENABLED=true
//   - no unapproved fields → return unblocked
export async function enforceCompletionInvariant(
  args: EnforceArgs,
): Promise<CompletionCheckResult> {
  const { prisma, caseId, targetStatus, currentStatus, actorUserId } = args;

  if (!TERMINAL_STATUSES.includes(targetStatus)) {
    return { blocked: false, unapprovedCount: 0, unapprovedFieldKeys: [] };
  }
  if (targetStatus === currentStatus) {
    return { blocked: false, unapprovedCount: 0, unapprovedFieldKeys: [] };
  }

  const check = await checkCompletionInvariant(prisma, caseId);
  if (check.unapprovedCount === 0) {
    return check;
  }

  const guardOn = isCompletionGuardEnabled();

  // Audit runs whether the guard blocks or observes. The count of these
  // rows over time is the signal for the workflow decision.
  await prisma.auditLog.create({
    data: {
      caseId,
      userId: actorUserId,
      action: "COMPLETION_BLOCKED",
      source: "SYSTEM",
      newValue: `${guardOn ? "Blocked" : "Would block"} ${currentStatus} → ${targetStatus}: ${check.unapprovedCount} field${check.unapprovedCount === 1 ? "" : "s"} unapproved`,
      metadata: {
        targetStatus,
        currentStatus,
        unapprovedFieldKeys: check.unapprovedFieldKeys,
        guardEnforced: guardOn,
      },
    },
  });

  return {
    blocked: guardOn,
    unapprovedCount: check.unapprovedCount,
    unapprovedFieldKeys: check.unapprovedFieldKeys,
  };
}
