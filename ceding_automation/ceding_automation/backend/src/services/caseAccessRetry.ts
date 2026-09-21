// backend/src/services/caseAccessRetry.ts
//
// Narrow sync helper for the requireCaseAccess middleware's sync-on-403
// recovery path. Deliberately smaller than the full sync-from-zoho
// route logic: it does not touch paraplanner, adviser, provider
// directory, cached Zoho IDs, or the Contact / Plans records. All it
// does is:
//
//   1. Fetch the Zoho Task.
//   2. Resolve the Zoho Task Owner email → an app user.
//   3. Update the case's assignedToId to that user, iff the resolved
//      user actually exists in our DB (no auto-provisioning inside an
//      access check — that would let a Zoho email trigger user
//      creation without any admin oversight).
//   4. Write a CASE_UPDATED audit with metadata.trigger = "access-retry"
//      so the trail says "case changed hands because someone tried
//      to open it".
//   5. Update case.zohoSyncedAt so the middleware's freshness gate
//      skips subsequent attempts within the cool-off window.
//
// The "Refresh from Zoho" button on the case-detail page continues to
// call the full /:id/sync-from-zoho route which does everything else
// (paraplanner, provider, plan record). Two helpers, two scopes,
// intentional.
//
// Runs inside a caller-supplied timeout so a slow Zoho does not stall
// the middleware; on timeout / error the caller 403s as it would
// have anyway.

import { PrismaClient, type Prisma } from "@prisma/client";
import { getTask, mapZohoTaskToCase } from "./zohoCrm";

const prisma = new PrismaClient();

export type AccessRetryOutcome =
  | "granted"           // sync applied, caller now has access
  | "still-refused"     // sync ran, caller still doesn't qualify
  | "task-gone"         // Zoho returned no task for this zohoTaskId
  | "no-zoho-owner"     // Zoho task has no resolvable owner
  | "owner-unknown"     // Zoho owner email doesn't map to any app user
  | "timeout"           // Zoho fetch exceeded the caller's deadline
  | "error"             // any other failure fetching / mapping
  | "skipped-no-link"   // case has no zohoTaskId
  | "skipped-fresh"     // case zohoSyncedAt is recent (freshness gate)
  | "skipped-cache"     // in-process LRU cache short-circuited
  | "skipped-rate-limit"; // per-user rate limit hit

export interface AccessRetryResult {
  outcome: AccessRetryOutcome;
  granted: boolean;
  /** Zoho Task Owner email seen at the moment of the retry. Null if
   *  Zoho did not return an owner or the fetch failed. Used both by
   *  the granted-audit metadata and by the denied-audit so ops can
   *  read "case Y belongs to Z in Zoho, not the caller". */
  zohoOwnerEmail: string | null;
  /** ms elapsed on the Zoho fetch + DB write. Zero for skipped
   *  outcomes. Logged in the structured line so latency of the
   *  retry path can be tracked separately from the base request. */
  latencyMs: number;
}

interface RetryInput {
  caseId: string;
  actorUserId: string;
  actorEmail: string | null;
  /** Milliseconds to wait for Zoho before giving up. Caller (the
   *  middleware) enforces the total budget; the helper races the
   *  Zoho fetch against this deadline. */
  timeoutMs: number;
}

/**
 * Attempt a narrow resync of a case's assignedToId from its Zoho
 * Task Owner, and report whether the actor now qualifies for
 * access. Never throws — every failure mode maps to an `outcome`.
 */
export async function syncAssignmentForAccessRetry(
  input: RetryInput,
): Promise<AccessRetryResult> {
  const startedAt = Date.now();
  let zohoOwnerEmail: string | null = null;

  try {
    // (1) Fetch the Zoho task, racing against the caller's timeout.
    // Zoho occasionally hangs on individual records (see
    // FH-2026-000218 — malformed-JSON then 502); the timeout is
    // load-bearing for the "legitimate 403 must not become slow"
    // property.
    const raw = await raceWithTimeout(
      // The Zoho client uses fetch which has no built-in per-request
      // timeout, so we impose one here rather than editing the
      // shared client.
      getTask(await extractTaskId(input.caseId)),
      input.timeoutMs,
    );
    if (raw === TIMED_OUT) {
      return {
        outcome: "timeout",
        granted: false,
        zohoOwnerEmail: null,
        latencyMs: Date.now() - startedAt,
      };
    }
    const taskRecord = Array.isArray((raw as { data?: unknown[] })?.data)
      ? ((raw as { data: Record<string, unknown>[] }).data[0] ?? null)
      : null;
    if (!taskRecord) {
      return {
        outcome: "task-gone",
        granted: false,
        zohoOwnerEmail: null,
        latencyMs: Date.now() - startedAt,
      };
    }

    const mapping = mapZohoTaskToCase(taskRecord);
    zohoOwnerEmail = mapping.ownerEmail?.toLowerCase() ?? null;

    if (!zohoOwnerEmail) {
      return {
        outcome: "no-zoho-owner",
        granted: false,
        zohoOwnerEmail: null,
        latencyMs: Date.now() - startedAt,
      };
    }

    // (2) Resolve the Zoho owner to an existing app user. No
    // auto-provisioning inside an access check — that would let an
    // arbitrary Zoho email trigger user creation with role=CA_TEAM
    // without any admin oversight. Full sync-from-zoho auto-creates;
    // this narrow retry does not. If the owner isn't a known user,
    // report `owner-unknown` and let the middleware 403 with an
    // audit — an admin can then decide whether to onboard.
    const zohoUser = await prisma.user.findFirst({
      where: { email: zohoOwnerEmail, status: "ACTIVE" },
      select: { id: true, email: true },
    });
    if (!zohoUser) {
      return {
        outcome: "owner-unknown",
        granted: false,
        zohoOwnerEmail,
        latencyMs: Date.now() - startedAt,
      };
    }

    // (3) Update assignedToId. We update unconditionally to keep the
    // DB in step with Zoho even if the Zoho owner is a THIRD person
    // (not the caller) — the caller will still 403, but the case's
    // assignedToId now reflects reality and the next legitimate
    // click-through by the actual Zoho owner won't need another
    // Zoho round-trip.
    //
    // We do NOT run the H18 locked-field guard here (assignedToId is
    // not a locked field). If Zoho has drifted on planType /
    // providerId / policyRef, that's a separate concern the full
    // Refresh-from-Zoho button will surface with its own audit
    // trail; we don't want the middleware to silently ignore locked
    // field disagreements it detected while syncing an assignment.
    const now = new Date();
    await prisma.case.update({
      where: { id: input.caseId },
      data: {
        assignedToId: zohoUser.id,
        zohoSyncedAt: now,
      },
    });

    // (4) Audit. Piggyback on the existing sync audit shape so
    // AuditTimeline renders it consistently; the `trigger` metadata
    // field distinguishes middleware-triggered syncs from
    // button-triggered ones.
    await prisma.auditLog.create({
      data: {
        caseId: input.caseId,
        userId: input.actorUserId,
        action: "CASE_UPDATED",
        source: "SYSTEM",
        newValue: "Assignee synced from Zoho on access-retry",
        metadata: {
          sync: "zoho",
          trigger: "access-retry",
          actorAttemptedFirst: input.actorUserId,
          actorEmail: input.actorEmail,
          zohoOwnerEmail,
          assignedTo: zohoUser.id,
          changes: [
            {
              field: "assignedTo",
              trigger: "access-retry",
            },
          ],
        } as Prisma.InputJsonValue,
      },
    });

    const granted = zohoUser.id === input.actorUserId;
    return {
      outcome: granted ? "granted" : "still-refused",
      granted,
      zohoOwnerEmail,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    // Any unexpected failure lands here — DB error, mapping throw,
    // etc. Fall through to error outcome; the middleware 403s.
    // eslint-disable-next-line no-console
    console.warn(
      "[access-retry] sync-attempt error",
      err instanceof Error ? err.message : String(err),
    );
    return {
      outcome: "error",
      granted: false,
      zohoOwnerEmail,
      latencyMs: Date.now() - startedAt,
    };
  }
}

// Race a promise against a millisecond deadline. Sentinel value on
// timeout lets the caller distinguish timeout from a resolved-null
// result without exceptions.
const TIMED_OUT = Symbol("access-retry:timeout");
async function raceWithTimeout<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T | typeof TIMED_OUT>([
      work,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Look up the case's zohoTaskId. Kept as a separate step so the
// middleware's freshness check can query the same row without a
// second read (it passes the id we already know) — but we still
// need the taskId here for the Zoho fetch. The middleware pre-loads
// the case row and confirms zohoTaskId != null before calling us; if
// somehow the row was deleted between those two reads, `getTask`
// will throw and we return `error`, which is the honest signal.
async function extractTaskId(caseId: string): Promise<string> {
  const row = await prisma.case.findUnique({
    where: { id: caseId },
    select: { zohoTaskId: true },
  });
  if (!row?.zohoTaskId) {
    throw new Error("no zohoTaskId (race with delete?)");
  }
  return row.zohoTaskId;
}
