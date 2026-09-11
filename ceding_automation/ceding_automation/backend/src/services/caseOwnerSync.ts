// backend/src/services/caseOwnerSync.ts
//
// Keeps Case.assignedToId in step with the live Zoho Task owner.
//
// Background. assignedToId is a cached mirror of the Zoho task owner. It is
// written once at import (crm.ts:255) and thereafter refreshed only as a
// side-effect of someone opening the case page — CaseDetail.tsx calls
// POST /cases/:id/sync-from-zoho on mount, and that is the only thing that
// rewrites the column.
//
// requireCaseAccess promoted that mirror to a security boundary, which turned
// a harmless staleness into a deadlock: when a task is reassigned in Zoho, the
// new owner fails the gate, so they can never open the page whose side-effect
// would have refreshed the mirror. Before the gate existed the mismatch healed
// itself silently (anyone could open any case); afterwards only an ADMIN, who
// short-circuits the gate, could unstick it.
//
// This module closes the loop without putting Zoho on the hot path. The DB
// stays the authority for the access decision — fast, and unaffected by a Zoho
// outage. Zoho is consulted only when the DB says "no", which is the one case
// where a stale mirror can do harm.

import { PrismaClient } from "@prisma/client";
import { getTask, findTaskIdsByOwner, findZohoUserByEmail } from "./zohoCrm";

const prisma = new PrismaClient();

export type RepairUser = { id: string; email: string };

// ── Abuse limits ────────────────────────────────────────────
// Every repair attempt costs one Zoho API call, on a path any authenticated
// user can trigger by requesting an id they don't own. Two limits bound it:
// a per-user+case cooldown (a refused id stays refused without re-asking
// Zoho), and a per-user budget (a sweep over many ids stops after a few).
const COOLDOWN_MS = 60_000;
const BUDGET_MAX = 20;
const BUDGET_WINDOW_MS = 10 * 60_000;

const lastAttempt = new Map<string, number>();
const budgets = new Map<string, { count: number; resetAt: number }>();

function pruneIfLarge(): void {
  // These maps are keyed by user+case, so they grow with traffic. Cheap
  // amortised sweep — the entries are only meaningful for COOLDOWN_MS.
  if (lastAttempt.size < 5000) return;
  const cutoff = Date.now() - COOLDOWN_MS;
  for (const [k, t] of lastAttempt) if (t < cutoff) lastAttempt.delete(k);
}

function takeBudget(userId: string): boolean {
  const now = Date.now();
  const b = budgets.get(userId);
  if (!b || now > b.resetAt) {
    budgets.set(userId, { count: 1, resetAt: now + BUDGET_WINDOW_MS });
    return true;
  }
  if (b.count >= BUDGET_MAX) return false;
  b.count += 1;
  return true;
}

function onCooldown(userId: string, caseId: string): boolean {
  const key = `${userId}:${caseId}`;
  const prev = lastAttempt.get(key);
  if (prev !== undefined && Date.now() - prev < COOLDOWN_MS) return true;
  lastAttempt.set(key, Date.now());
  pruneIfLarge();
  return false;
}

// Zoho Task.Owner is { id, name, email } (see mapZohoTaskToCase). getTask
// returns the raw v6 envelope, so the record is data[0].
function extractOwnerEmail(payload: unknown): string | null {
  const data = (payload as { data?: unknown[] } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const owner = (data[0] as Record<string, unknown>).Owner as
    | Record<string, unknown>
    | undefined;
  const email = owner && typeof owner.email === "string" ? owner.email.trim() : "";
  return email.length > 0 ? email.toLowerCase() : null;
}

/**
 * Last-chance check before refusing a case request: ask Zoho who owns the
 * underlying task, and if it is this very user, adopt that answer.
 *
 * Deliberately narrow. It grants access on exactly one condition — Zoho says
 * the requesting user owns the task — and the only write it performs is to
 * set that same user as assignedToId. It never clears an owner and never
 * assigns a third party, so it cannot be used to take a case from someone or
 * to strand one with no owner. Anything unexpected (no task id, Zoho error,
 * owner is somebody else) returns false and the caller's 403 stands.
 *
 * @returns true if access should be granted (and the mirror was corrected)
 */
export async function repairCaseOwnerFromZoho(
  caseId: string,
  user: RepairUser,
): Promise<boolean> {
  if (onCooldown(user.id, caseId)) return false;
  if (!takeBudget(user.id)) return false;

  try {
    const row = await prisma.case.findUnique({
      where: { id: caseId },
      select: { id: true, zohoTaskId: true, assignedToId: true },
    });
    // No case, or one that did not come from CRM — nothing to reconcile.
    if (!row?.zohoTaskId) return false;

    const ownerEmail = extractOwnerEmail(await getTask(row.zohoTaskId));
    if (!ownerEmail) return false;
    if (ownerEmail !== user.email.toLowerCase()) return false;

    // Raced with another repair (or a page-open sync) — already correct.
    if (row.assignedToId === user.id) return true;

    const previousAssignee = row.assignedToId;
    await prisma.case.update({
      where: { id: caseId },
      data: { assignedToId: user.id },
    });

    // Ownership changing hands is exactly the kind of event the audit trail
    // exists for, and this path changes it without a human action to point
    // at — so record what happened and why.
    await prisma.auditLog.create({
      data: {
        caseId,
        userId: user.id,
        action: "CASE_ASSIGNED",
        source: "SYSTEM",
        oldValue: previousAssignee,
        newValue: user.id,
        metadata: {
          reason: "zoho-owner-reconciliation",
          trigger: "case-access-denied",
          zohoTaskId: row.zohoTaskId,
          zohoOwnerEmail: ownerEmail,
        },
      },
    });

    return true;
  } catch (err) {
    // Fail closed: a Zoho outage must never widen access, and must never
    // turn a 403 into a 500.
    // eslint-disable-next-line no-console
    console.warn(
      `[caseOwnerSync] repair failed for case ${caseId}:`,
      (err as Error).message,
    );
    return false;
  }
}

/**
 * At sign-in, bring every case this user owns in Zoho into line with the DB.
 *
 * The on-deny repair above fixes a case the user navigates to directly, but
 * the case LIST is scoped by the same columns (cases.ts:421-433) — so a stale
 * row does not merely refuse to open, it is absent from the list entirely and
 * the user has no way to reach it. One question to Zoho at login ("which
 * tasks do you own?") corrects the whole set before they look at it.
 *
 * Asking it this way round costs one API call per sign-in. Asking the
 * equivalent question per case ("who owns this?") would cost one per case.
 *
 * Like the repair, this only ever writes the signing-in user into
 * assignedToId, and only for tasks Zoho says they own. It deliberately does
 * NOT clear cases the DB assigns to them but Zoho no longer does: withdrawing
 * access is a heavier decision than granting it, the page-open sync already
 * handles that direction, and getting it wrong would lock someone out.
 *
 * Fire-and-forget — never block or fail a login on this.
 *
 * @returns how many cases were corrected
 */
export async function reconcileOwnedCasesAtLogin(
  user: RepairUser,
): Promise<number> {
  try {
    // Note: this resolves the CRM user by the address they signed in with.
    // Someone whose CRM identity uses a different address (an appointed-
    // representative firm email, say) will not match here and is unaffected.
    const zohoUser = await findZohoUserByEmail(user.email);
    if (!zohoUser?.id) return 0;

    const taskIds = await findTaskIdsByOwner(zohoUser.id);
    if (taskIds.length === 0) return 0;

    const stale = await prisma.case.findMany({
      where: { zohoTaskId: { in: taskIds }, NOT: { assignedToId: user.id } },
      select: { id: true, assignedToId: true, zohoTaskId: true },
    });
    if (stale.length === 0) return 0;

    await prisma.case.updateMany({
      where: { id: { in: stale.map((c) => c.id) } },
      data: { assignedToId: user.id },
    });

    await prisma.auditLog.createMany({
      data: stale.map((c) => ({
        caseId: c.id,
        userId: user.id,
        action: "CASE_ASSIGNED" as const,
        source: "SYSTEM" as const,
        oldValue: c.assignedToId,
        newValue: user.id,
        metadata: {
          reason: "zoho-owner-reconciliation",
          trigger: "sign-in",
          zohoTaskId: c.zohoTaskId,
        },
      })),
    });

    return stale.length;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[caseOwnerSync] login reconciliation failed for ${user.email}:`,
      (err as Error).message,
    );
    return 0;
  }
}
