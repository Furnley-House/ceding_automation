// backend/src/middleware/requireCaseAccess.ts
//
// Case-scoped authorisation. Attach after requireAuth on every route that
// operates on a single case (identified by :id or :caseId in the URL).
// Mirrors the OR clause the case-list route uses at cases.ts:421-433 so
// what a user can list is exactly what they can fetch or mutate — never
// broader. ADMIN short-circuits without a DB hit, matching the list.
//
// Closes a pre-existing exposure where any authenticated user could
// fetch any case by id — GET /cases/:id used findUnique with no user
// filter, and every sub-route (checklist, documents, fundLines,
// contributions, export) took :caseId with no filter at all. The gap
// went live with feat/adviser-scope-and-approval which granted advisers
// their own case list to enumerate ids from.
//
// Deliberately NOT mounted on routes guarded by requireInternalKey
// (checklist.ts:635, documents.ts:985 — the BFF write-back paths).
// Those have no human user; requireInternalKey sets req.user to
// SYSTEM_USER_ID with role=ADMIN, so a stray mount would still pass,
// but by convention internal-key routes carry only requireInternalKey.
// Enforce at review: no route should mount both.
//
// ── 2026-09-19 access-retry recovery path ─────────────────────────────
// Zoho task reassignment (Aruna redistributes → task Owner changes in
// Zoho → target CA opens the case in the app) previously stuck: the
// app's assignedToId still pointed at Aruna, so this middleware 403'd
// the target CA, and the only path to fix it was `Refresh from Zoho`
// on the case-detail page — which the target CA couldn't reach because
// they couldn't open the page. Catch-22.
//
// The retry path: when the initial DB check fails but the case has a
// zohoTaskId and hasn't been synced recently, run a narrow Zoho resync
// (services/caseAccessRetry.ts), re-run the DB check, and let the
// caller through if they now qualify. Otherwise write a
// CASE_ACCESS_RETRY_DENIED audit row and 403 as before.
//
// Cost-of-legitimate-403 is the load-bearing property: users poking at
// URLs they don't own MUST NOT pay a Zoho round-trip on every attempt.
// Three cheap gates protect that: zohoTaskId presence, freshness
// window (5 min), and a per-user-per-case in-process LRU (60 s). See
// the guard block below.

import { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import { syncAssignmentForAccessRetry, type AccessRetryOutcome } from "../services/caseAccessRetry";

const prisma = new PrismaClient();

// Tunable knobs. Deliberately not env vars — this middleware runs on
// every case-scoped request and the values are load-bearing enough
// that changing them should require a code review + redeploy, not a
// container-env twiddle. Revisit these numbers after the first day of
// [access-retry] structured-log data.
const FRESHNESS_WINDOW_MS = 5 * 60 * 1000;      // skip Zoho if synced in the last 5 min
const CACHE_TTL_MS = 60 * 1000;                 // in-process LRU per (caseId, userId)
const RATE_LIMIT_PER_USER_PER_MIN = 10;         // sync-on-403 attempts per user per rolling minute
const ZOHO_FETCH_TIMEOUT_MS = 3_000;            // per-attempt Zoho deadline

// In-process caches. Node single-instance per container replica —
// prod runs 2 replicas so effective limits are ~2× these values,
// which is fine for the abuse-prevention we want (an attacker
// enumerating case ids is going to be constrained regardless).
// The Zoho outage story ALSO improves under multi-replica because a
// single hung replica doesn't stall the fleet's retry budget.
const attemptCache = new Map<string, number>();          // `${caseId}::${userId}` → expiry ms
const perUserAttempts = new Map<string, number[]>();     // userId → sliding-window timestamps

/** Structured log line every retry-path decision. One line per event,
 *  JSON payload for Log Analytics ingestion. Emit via console.log so
 *  it lands on stdout without a new logger dependency. Keys chosen to
 *  match the "sync-on-403-outcome" telemetry field name we agreed at
 *  scope-time; downstream KQL can pivot on `outcome` alone. */
function logRetry(fields: {
  event: "access-retry";
  outcome: AccessRetryOutcome | "granted-first-check";
  caseId: string;
  caseRef?: string | null;
  userId: string;
  userEmail: string | null;
  zohoOwnerEmail: string | null;
  latencyMs: number;
  cacheHit?: boolean;
  rateLimited?: boolean;
}) {
  // eslint-disable-next-line no-console
  console.log("[access-retry] " + JSON.stringify(fields));
}

function cacheKey(caseId: string, userId: string): string {
  return `${caseId}::${userId}`;
}

/** Best-effort GC of expired entries — called lazily on every retry
 *  path. Bounds the cache size without a background timer. */
function pruneExpiredCache(now: number): void {
  if (attemptCache.size < 500) return;
  for (const [k, exp] of attemptCache.entries()) {
    if (exp <= now) attemptCache.delete(k);
  }
}

function recordAttempt(userId: string, now: number): boolean {
  const cutoff = now - 60_000;
  const arr = (perUserAttempts.get(userId) ?? []).filter((t) => t > cutoff);
  if (arr.length >= RATE_LIMIT_PER_USER_PER_MIN) {
    perUserAttempts.set(userId, arr);
    return false;
  }
  arr.push(now);
  perUserAttempts.set(userId, arr);
  return true;
}

/** Query the OR clause. Kept as a named function so the retry path
 *  can call it twice (initial check + post-sync recheck) without
 *  duplicating the where-shape. */
async function checkAccess(caseId: string, userId: string): Promise<boolean> {
  const row = await prisma.case.findFirst({
    where: {
      id: caseId,
      OR: [
        { createdById: userId },
        { assignedToId: userId },
        { paralPlannerId: userId },
        { adviserId: userId },
      ],
    },
    select: { id: true },
  });
  return !!row;
}

export async function requireCaseAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    // requireAuth must run before this. Guard anyway so a mis-ordered
    // mount 401s rather than crashing on undefined below.
    return res.status(401).json({ error: "No token provided" });
  }

  // ADMIN sees all cases — mirrors the list short-circuit at cases.ts:420
  // (`if (req.user!.role !== "ADMIN") { where.OR = [...] }`). No DB hit.
  if (req.user.role === "ADMIN") return next();

  // Case identifier arrives as either :id (cases.ts /:id family +
  // export.ts /:id/complete-export) or :caseId (checklist / documents /
  // fundLines / contributions / audit / calls routes).
  //
  // TRAP — do NOT swap this order back. Two contributions routes carry
  // BOTH :caseId AND :id in the path
  // (PATCH /:caseId/contributions/:id and
  //  POST  /:caseId/contributions/:id/transactions), where the :id is a
  // CHILD row id (contribution row), NOT a case id. Reading :id first
  // makes the case lookup below query by contribution id → no match →
  // 403 for legitimate users. This shipped to prod on 2026-09-06 via
  // 3e0c515 and 403'd every non-ADMIN contribution edit until the
  // one-line hotfix that reversed the precedence. Regression covered
  // by requireCaseAccess.test.ts "prefers :caseId when BOTH …" —
  // that test fails immediately if this order is swapped back.
  //
  // Rule: prefer :caseId. Routes with only :id (no :caseId) resolve
  // correctly via the fall-through; routes with only :caseId already
  // preferred it; routes with both now pick the correct one.
  const caseId = (req.params.caseId ?? req.params.id) as string | undefined;
  if (!caseId) {
    // Middleware mounted on a path with no case identifier — programmer
    // error. Fail closed rather than silently pass.
    return res
      .status(500)
      .json({ error: "requireCaseAccess: no caseId in route params" });
  }

  // Initial DB check — fast path for the 99%+ of requests that just
  // work. Only when this fails do we consider a Zoho resync.
  if (await checkAccess(caseId, req.user.id)) return next();

  // ── Sync-on-403 recovery path ────────────────────────────────────
  // Three cheap gates protect the "legitimate 403 must stay fast"
  // property. Every branch below emits exactly one structured log
  // line before it returns; that per-day dataset is what will tell
  // us whether the freshness window is set correctly.
  const now = Date.now();
  const userId = req.user.id;
  const userEmail = req.user.email ?? null;

  // Load minimal case metadata we need for the guards + audits. This
  // is one extra query on the 403 path; the fast path pays nothing.
  const caseMeta = await prisma.case.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      caseRef: true,
      zohoTaskId: true,
      zohoSyncedAt: true,
    },
  });
  // Unknown caseId → 403 as before (do not sync). This matches the
  // pre-2026-09-19 behaviour of `findFirst` returning null; we
  // continue to treat unknown vs unauthorised as one bucket so an
  // attacker can't distinguish "case doesn't exist" from "you
  // don't have access".
  if (!caseMeta) {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  // Guard 1 — no Zoho link means we can't possibly recover.
  if (!caseMeta.zohoTaskId) {
    logRetry({
      event: "access-retry",
      outcome: "skipped-no-link",
      caseId,
      caseRef: caseMeta.caseRef,
      userId,
      userEmail,
      zohoOwnerEmail: null,
      latencyMs: 0,
    });
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  // Guard 2 — freshness window. If the case was synced from Zoho in
  // the last FRESHNESS_WINDOW_MS, another sync will produce the same
  // answer. Skip the round-trip and 403.
  const freshEnough =
    caseMeta.zohoSyncedAt &&
    now - caseMeta.zohoSyncedAt.getTime() < FRESHNESS_WINDOW_MS;
  if (freshEnough) {
    logRetry({
      event: "access-retry",
      outcome: "skipped-fresh",
      caseId,
      caseRef: caseMeta.caseRef,
      userId,
      userEmail,
      zohoOwnerEmail: null,
      latencyMs: 0,
    });
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  // Guard 3 — per-(case,user) in-process cache. Catches tight retry
  // loops (a dashboard mount firing 6 parallel case queries; a
  // page reload happening before the DB write from a prior attempt
  // has landed) without touching Zoho.
  pruneExpiredCache(now);
  const key = cacheKey(caseId, userId);
  const cachedUntil = attemptCache.get(key);
  if (cachedUntil && cachedUntil > now) {
    logRetry({
      event: "access-retry",
      outcome: "skipped-cache",
      caseId,
      caseRef: caseMeta.caseRef,
      userId,
      userEmail,
      zohoOwnerEmail: null,
      latencyMs: 0,
      cacheHit: true,
    });
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  // Guard 4 — per-user sliding-window rate limit. An attacker
  // enumerating case ids is capped at RATE_LIMIT_PER_USER_PER_MIN
  // Zoho GETs per minute; also protects Zoho from a runaway client.
  if (!recordAttempt(userId, now)) {
    logRetry({
      event: "access-retry",
      outcome: "skipped-rate-limit",
      caseId,
      caseRef: caseMeta.caseRef,
      userId,
      userEmail,
      zohoOwnerEmail: null,
      latencyMs: 0,
      rateLimited: true,
    });
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  // All gates passed — attempt the resync.
  const result = await syncAssignmentForAccessRetry({
    caseId,
    actorUserId: userId,
    actorEmail: userEmail,
    timeoutMs: ZOHO_FETCH_TIMEOUT_MS,
  });

  // Bump the cache regardless of outcome — we've paid the Zoho
  // round-trip, no point paying it again in the next 60 s.
  attemptCache.set(key, now + CACHE_TTL_MS);

  if (result.granted) {
    // Re-check the DB in case something race-y happened between the
    // helper's write and this read (multi-replica ordering, etc.).
    // In practice the helper's write is on the same PrismaClient
    // instance so this is effectively free — but it's the safety net
    // that keeps us from silently authorising on stale state.
    if (await checkAccess(caseId, userId)) {
      logRetry({
        event: "access-retry",
        outcome: "granted",
        caseId,
        caseRef: caseMeta.caseRef,
        userId,
        userEmail,
        zohoOwnerEmail: result.zohoOwnerEmail,
        latencyMs: result.latencyMs,
      });
      return next();
    }
    // Fell through — treat as still-refused. Rare; log distinctly by
    // reusing the same outcome so ops sees the recheck-race pattern
    // via the caseRef, not a new bucket.
    logRetry({
      event: "access-retry",
      outcome: "still-refused",
      caseId,
      caseRef: caseMeta.caseRef,
      userId,
      userEmail,
      zohoOwnerEmail: result.zohoOwnerEmail,
      latencyMs: result.latencyMs,
    });
  } else {
    logRetry({
      event: "access-retry",
      outcome: result.outcome,
      caseId,
      caseRef: caseMeta.caseRef,
      userId,
      userEmail,
      zohoOwnerEmail: result.zohoOwnerEmail,
      latencyMs: result.latencyMs,
    });
  }

  // Retry ran but the caller still doesn't qualify — write the
  // dedicated denied audit so ops can see "person X wanted case Y
  // and Zoho didn't back them up either" without grepping metadata.
  // Fail-soft: an audit-write hiccup must not turn a 403 into a
  // 500. Wrap in a try/catch; a warn line is enough on failure.
  try {
    await prisma.auditLog.create({
      data: {
        caseId,
        userId,
        action: "CASE_ACCESS_RETRY_DENIED",
        source: "SYSTEM",
        newValue: `Access retry denied (${result.outcome})`,
        metadata: {
          userEmail,
          caseRef: caseMeta.caseRef,
          zohoTaskId: caseMeta.zohoTaskId,
          syncOutcome: result.outcome,
          zohoOwnerEmail: result.zohoOwnerEmail,
          latencyMs: result.latencyMs,
        },
      },
    });
  } catch (auditErr) {
    // eslint-disable-next-line no-console
    console.warn(
      "[access-retry] audit-write failed",
      auditErr instanceof Error ? auditErr.message : String(auditErr),
    );
  }

  return res.status(403).json({ error: "Insufficient permissions" });
}

// Test-only hooks — exported so unit tests can reset per-process
// state between cases. Not part of the runtime contract.
export function __resetAccessRetryStateForTests(): void {
  attemptCache.clear();
  perUserAttempts.clear();
}
