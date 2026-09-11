import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "@prisma/client";

// Mock the Prisma client BEFORE importing the middleware — the module
// instantiates a PrismaClient at import time. vi.mock is hoisted above
// this file's top-level statements, so the shared mock fn needs
// vi.hoisted() to also be available before the mock factory runs.
const { findFirstMock, repairMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  repairMock: vi.fn(),
}));
vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(() => ({
    case: { findFirst: findFirstMock },
  })),
}));

// The on-deny Zoho repair is exercised in services/caseOwnerSync.test.ts.
// Here it is stubbed so these tests cover the guard decision alone, and so a
// denial is a real denial rather than the repair happening to throw.
vi.mock("../services/caseOwnerSync", () => ({
  repairCaseOwnerFromZoho: repairMock,
}));

import { requireCaseAccess } from "./requireCaseAccess";

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

beforeEach(() => {
  findFirstMock.mockReset();
  repairMock.mockReset();
  repairMock.mockResolvedValue(false); // default: Zoho does not vouch for the user
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
    });
  }

  // ── Denial ──────────────────────────────────────────────────────────
  it("returns 403 when the user has no relationship to the case", async () => {
    findFirstMock.mockResolvedValueOnce(null); // no matching row
    const req = makeReq({ user: USER("ADVISER"), caseId: "case-1" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Insufficient permissions",
    });
  });

  it("denies a CA_TEAM user with no relationship (regression: same for every non-ADMIN role)", async () => {
    findFirstMock.mockResolvedValueOnce(null);
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

  // -- On-deny Zoho repair ---------------------------------------------
  // assignedToId is a cached mirror of the Zoho task owner, refreshed only
  // when someone opens the case page. Reassign a task in Zoho and the new
  // owner fails the check above, then cannot open the page whose sync would
  // have corrected it. The repair breaks that deadlock by letting Zoho have
  // the final word before the refusal stands.
  it("grants access when the DB says no but Zoho names the user as the owner", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    repairMock.mockResolvedValueOnce(true);
    const req = makeReq({ user: USER("CA_TEAM"), id: "case-1" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(repairMock).toHaveBeenCalledWith("case-1", {
      id: "user-1",
      email: "user-1@test",
    });
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("keeps the 403 when Zoho does not name the user as the owner", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    repairMock.mockResolvedValueOnce(false);
    const req = makeReq({ user: USER("CA_TEAM"), id: "case-1" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Insufficient permissions",
    });
  });

  it("does not consult Zoho when the DB already grants access (no cost on the happy path)", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "case-1" });
    const req = makeReq({ user: USER("CA_TEAM"), id: "case-1" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(repairMock).not.toHaveBeenCalled();
  });

  it("does not consult Zoho for ADMIN (short-circuits before any lookup)", async () => {
    const req = makeReq({ user: USER("ADMIN"), id: "case-1" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    await requireCaseAccess(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(repairMock).not.toHaveBeenCalled();
  });
});
