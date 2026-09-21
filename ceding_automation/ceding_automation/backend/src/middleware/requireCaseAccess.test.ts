import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "@prisma/client";

// Mock the Prisma client BEFORE importing the middleware — the module
// instantiates a PrismaClient at import time. vi.mock is hoisted above
// this file's top-level statements, so the shared mock fn needs
// vi.hoisted() to also be available before the mock factory runs.
const {
  findFirstMock,
  findUniqueMock,
  auditCreateMock,
  syncRetryMock,
} = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  findUniqueMock: vi.fn(),
  auditCreateMock: vi.fn().mockResolvedValue({}),
  syncRetryMock: vi.fn(),
}));
vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(() => ({
    case: { findFirst: findFirstMock, findUnique: findUniqueMock },
    auditLog: { create: auditCreateMock },
  })),
}));
vi.mock("../services/caseAccessRetry", () => ({
  syncAssignmentForAccessRetry: syncRetryMock,
}));

import {
  requireCaseAccess,
  __resetAccessRetryStateForTests,
} from "./requireCaseAccess";

type MockUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  canAccessAiTraining: boolean;
};

function makeReq(opts: {
  user?: MockUser;
  id?: string;
  caseId?: string;
}): Request {
  return {
    user: opts.user,
    params: {
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      ...(opts.caseId !== undefined ? { caseId: opts.caseId } : {}),
    },
  } as unknown as Request;
}

function makeRes() {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const USER = (role: UserRole = "CA_TEAM", id = "user-1"): MockUser => ({
  id,
  email: `${id}@test`,
  name: id,
  role,
  canAccessAiTraining: false,
});

// Capture stdout of the [access-retry] JSON log lines so tests can
// assert on the structured field values.
const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

function retryLogs(): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((c) => String(c[0] ?? ""))
    .filter((s) => s.startsWith("[access-retry] "))
    .map((s) => JSON.parse(s.slice("[access-retry] ".length)) as Record<string, unknown>);
}

beforeEach(() => {
  findFirstMock.mockReset();
  findUniqueMock.mockReset();
  auditCreateMock.mockReset().mockResolvedValue({});
  syncRetryMock.mockReset();
  logSpy.mockClear();
  __resetAccessRetryStateForTests();
});

describe("requireCaseAccess", () => {
  // ── ADMIN short-circuit ─────────────────────────────────────────────
  it("ADMIN passes without a DB hit, even on a case with no relationship", async () => {
    const req = makeReq({ user: USER("ADMIN"), id: "case-x" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  // ── Access via each of the four relations ───────────────────────────
  for (const relation of [
    "createdById",
    "assignedToId",
    "paralPlannerId",
    "adviserId",
  ] as const) {
    it(`grants access when user matches ${relation}`, async () => {
      findFirstMock.mockResolvedValueOnce({ id: "case-1" });
      const req = makeReq({ user: USER("ADVISER"), caseId: "case-1" });
      const res = makeRes();
      const next = vi.fn() as NextFunction;
      await requireCaseAccess(req, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      // Confirm the OR clause is exactly the four we mirror from cases.ts:421-433.
      const whereArg = findFirstMock.mock.calls[0][0].where;
      expect(whereArg.id).toBe("case-1");
      expect(whereArg.OR).toEqual([
        { createdById: "user-1" },
        { assignedToId: "user-1" },
        { paralPlannerId: "user-1" },
        { adviserId: "user-1" },
      ]);
      // Fast-path must not touch the retry helper or metadata fetch.
      expect(syncRetryMock).not.toHaveBeenCalled();
      expect(findUniqueMock).not.toHaveBeenCalled();
    });
  }

  // ── Denial + retry path gates ───────────────────────────────────────
  it("returns 403 without a Zoho call when case has no zohoTaskId (skipped-no-link)", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: "case-1",
      caseRef: "FH-2026-000001",
      zohoTaskId: null,
      zohoSyncedAt: null,
    });
    const req = makeReq({ user: USER("ADVISER"), caseId: "case-1" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(syncRetryMock).not.toHaveBeenCalled();
    const logs = retryLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: "access-retry",
      outcome: "skipped-no-link",
      caseId: "case-1",
      caseRef: "FH-2026-000001",
      userId: "user-1",
      latencyMs: 0,
    });
    // No sync ran → no denied-audit row either (denied-audit only
    // fires when the sync attempted and refused).
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("skips Zoho when zohoSyncedAt is within the freshness window (skipped-fresh)", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: "case-2",
      caseRef: "FH-2026-000002",
      zohoTaskId: "zoho-task-2",
      // Synced 60 seconds ago — well inside the 5-minute window.
      zohoSyncedAt: new Date(Date.now() - 60_000),
    });
    const req = makeReq({ user: USER("ADVISER"), caseId: "case-2" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(syncRetryMock).not.toHaveBeenCalled();
    expect(retryLogs()[0]).toMatchObject({ outcome: "skipped-fresh" });
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("runs the retry, grants access when the sync now qualifies the caller (granted)", async () => {
    // First check fails; retry sync succeeds; recheck passes.
    findFirstMock
      .mockResolvedValueOnce(null)   // initial check
      .mockResolvedValueOnce({ id: "case-3" }); // recheck after sync
    findUniqueMock.mockResolvedValueOnce({
      id: "case-3",
      caseRef: "FH-2026-000003",
      zohoTaskId: "zoho-task-3",
      zohoSyncedAt: null, // never synced
    });
    syncRetryMock.mockResolvedValueOnce({
      outcome: "granted",
      granted: true,
      zohoOwnerEmail: "user-1@test",
      latencyMs: 420,
    });
    const req = makeReq({ user: USER("ADVISER"), caseId: "case-3" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    // Helper was called with the actor's identity + timeout.
    expect(syncRetryMock).toHaveBeenCalledWith({
      caseId: "case-3",
      actorUserId: "user-1",
      actorEmail: "user-1@test",
      timeoutMs: 3000,
    });
    expect(retryLogs()[0]).toMatchObject({
      outcome: "granted",
      caseId: "case-3",
      caseRef: "FH-2026-000003",
      userId: "user-1",
      zohoOwnerEmail: "user-1@test",
      latencyMs: 420,
    });
    // Granted path does NOT write the denied audit.
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("runs the retry, 403s + writes denied audit when Zoho still doesn't back the caller (still-refused)", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: "case-4",
      caseRef: "FH-2026-000004",
      zohoTaskId: "zoho-task-4",
      zohoSyncedAt: null,
    });
    syncRetryMock.mockResolvedValueOnce({
      outcome: "still-refused",
      granted: false,
      zohoOwnerEmail: "someone-else@test",
      latencyMs: 350,
    });
    const req = makeReq({ user: USER("ADVISER"), caseId: "case-4" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(retryLogs()[0]).toMatchObject({ outcome: "still-refused" });
    // Denied audit fires with a proper action + metadata shape.
    expect(auditCreateMock).toHaveBeenCalledOnce();
    const auditArg = auditCreateMock.mock.calls[0][0].data;
    expect(auditArg.action).toBe("CASE_ACCESS_RETRY_DENIED");
    expect(auditArg.source).toBe("SYSTEM");
    expect(auditArg.caseId).toBe("case-4");
    expect(auditArg.userId).toBe("user-1");
    expect(auditArg.metadata).toMatchObject({
      userEmail: "user-1@test",
      caseRef: "FH-2026-000004",
      zohoTaskId: "zoho-task-4",
      syncOutcome: "still-refused",
      zohoOwnerEmail: "someone-else@test",
    });
  });

  it("emits denied-audit and log for timeout outcome (Zoho slow → 403 as before)", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: "case-5",
      caseRef: "FH-2026-000005",
      zohoTaskId: "zoho-task-5",
      zohoSyncedAt: null,
    });
    syncRetryMock.mockResolvedValueOnce({
      outcome: "timeout",
      granted: false,
      zohoOwnerEmail: null,
      latencyMs: 3000,
    });
    const req = makeReq({ user: USER("ADVISER"), caseId: "case-5" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(retryLogs()[0]).toMatchObject({ outcome: "timeout" });
    expect(auditCreateMock.mock.calls[0][0].data.metadata.syncOutcome).toBe("timeout");
  });

  it("in-process cache short-circuits a second attempt within TTL (skipped-cache)", async () => {
    // First attempt — sync runs, still refused. Cache is now warm.
    findFirstMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: "case-6",
      caseRef: "FH-2026-000006",
      zohoTaskId: "zoho-task-6",
      zohoSyncedAt: null,
    });
    syncRetryMock.mockResolvedValueOnce({
      outcome: "still-refused",
      granted: false,
      zohoOwnerEmail: "third@test",
      latencyMs: 220,
    });
    const req1 = makeReq({ user: USER("ADVISER"), caseId: "case-6" });
    await requireCaseAccess(req1, makeRes(), vi.fn() as NextFunction);
    expect(syncRetryMock).toHaveBeenCalledOnce();

    // Second attempt — same (case, user). Cache should skip Zoho entirely.
    findFirstMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: "case-6",
      caseRef: "FH-2026-000006",
      zohoTaskId: "zoho-task-6",
      zohoSyncedAt: null,
    });
    const req2 = makeReq({ user: USER("ADVISER"), caseId: "case-6" });
    const res2 = makeRes();
    await requireCaseAccess(req2, res2, vi.fn() as NextFunction);
    expect(res2.status).toHaveBeenCalledWith(403);
    // Sync helper NOT called again — cache saved a Zoho round-trip.
    expect(syncRetryMock).toHaveBeenCalledOnce();
    const cachedLog = retryLogs().at(-1);
    expect(cachedLog).toMatchObject({ outcome: "skipped-cache", cacheHit: true });
  });

  it("per-user rate limit skips Zoho after the 10th attempt in a rolling minute (skipped-rate-limit)", async () => {
    // Fire 10 attempts against different cases — each triggers a sync
    // that still-refuses. On the 11th, the rate-limit gate kicks in
    // before the sync is even called.
    syncRetryMock.mockResolvedValue({
      outcome: "still-refused",
      granted: false,
      zohoOwnerEmail: "third@test",
      latencyMs: 100,
    });
    for (let i = 1; i <= 10; i++) {
      findFirstMock.mockResolvedValueOnce(null);
      findUniqueMock.mockResolvedValueOnce({
        id: `case-rl-${i}`,
        caseRef: `FH-2026-RL${i}`,
        zohoTaskId: `zoho-task-rl-${i}`,
        zohoSyncedAt: null,
      });
      await requireCaseAccess(
        makeReq({ user: USER("ADVISER"), caseId: `case-rl-${i}` }),
        makeRes(),
        vi.fn() as NextFunction,
      );
    }
    expect(syncRetryMock).toHaveBeenCalledTimes(10);

    // 11th attempt from same user, brand-new case id (bypasses cache).
    findFirstMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: "case-rl-11",
      caseRef: "FH-2026-RL11",
      zohoTaskId: "zoho-task-rl-11",
      zohoSyncedAt: null,
    });
    const res11 = makeRes();
    await requireCaseAccess(
      makeReq({ user: USER("ADVISER"), caseId: "case-rl-11" }),
      res11,
      vi.fn() as NextFunction,
    );
    expect(res11.status).toHaveBeenCalledWith(403);
    // Sync count did NOT rise — rate limit intervened first.
    expect(syncRetryMock).toHaveBeenCalledTimes(10);
    const rlLog = retryLogs().at(-1);
    expect(rlLog).toMatchObject({ outcome: "skipped-rate-limit", rateLimited: true });
  });

  it("unknown caseId 403s without running the retry (no info leak: same shape as 'not authorised')", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce(null); // case genuinely doesn't exist
    const req = makeReq({ user: USER("ADVISER"), caseId: "nonexistent" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(syncRetryMock).not.toHaveBeenCalled();
    // No log line either — we don't want an attacker to be able to
    // distinguish "no such case" from any other refusal by probing
    // for a log-signal difference.
    expect(retryLogs()).toHaveLength(0);
  });

  it("denies a CA_TEAM user with no relationship (regression: same for every non-ADMIN role)", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    findUniqueMock.mockResolvedValueOnce({
      id: "case-1",
      caseRef: null,
      zohoTaskId: null,
      zohoSyncedAt: null,
    });
    const req = makeReq({ user: USER("CA_TEAM"), caseId: "case-1" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // ── Param resolution ────────────────────────────────────────────────
  it("reads caseId from req.params.id (cases.ts routes)", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "case-abc" });
    const req = makeReq({ user: USER("ADVISER"), id: "case-abc" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(findFirstMock.mock.calls[0][0].where.id).toBe("case-abc");
    expect(next).toHaveBeenCalledOnce();
  });

  it("reads caseId from req.params.caseId (sub-route files)", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "case-xyz" });
    const req = makeReq({ user: USER("ADVISER"), caseId: "case-xyz" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(findFirstMock.mock.calls[0][0].where.id).toBe("case-xyz");
    expect(next).toHaveBeenCalledOnce();
  });

  // Regression guard for the prod incident on 2026-09-06: two
  // contributions routes carry both :caseId AND :id (where :id is a
  // child-row id, not a case id). Reading :id first queries the case
  // table by contribution id → no match → 403 for legitimate users.
  // This test locks the resolution order so a future edit swapping
  // req.params.caseId ?? req.params.id back to
  // req.params.id ?? req.params.caseId fails immediately.
  it("prefers :caseId when BOTH :caseId and a non-case :id are present (regression: prod 403 incident 2026-09-06)", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "the-real-case-id" });
    // Mirrors PATCH /:caseId/contributions/:id — :caseId is the case,
    // :id is the child contribution row. The middleware must query by
    // :caseId ("the-real-case-id"), not by :id ("contrib-row-xyz").
    const req = makeReq({
      user: USER("ADVISER"),
      caseId: "the-real-case-id",
      id: "contrib-row-xyz",
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(findFirstMock).toHaveBeenCalledOnce();
    const whereArg = findFirstMock.mock.calls[0][0].where;
    expect(whereArg.id).toBe("the-real-case-id");
    expect(whereArg.id).not.toBe("contrib-row-xyz");
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  // ── Fail-closed guards ──────────────────────────────────────────────
  it("401s when req.user is missing (misordered mount — should be after requireAuth)", async () => {
    const req = makeReq({ id: "case-1" }); // no user
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("500s when no case identifier is in route params (programmer error — fails closed)", async () => {
    const req = makeReq({ user: USER("ADVISER") }); // no id or caseId
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(findFirstMock).not.toHaveBeenCalled();
  });
});
