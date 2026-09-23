// HTTP-level tests for the two verification routes on fundLines.
//
// The guards are mocked so these exercise the route bodies, but each guard is
// also asserted to be IN the chain — a route that quietly lost requireCaseAccess
// would leak another case's holdings, and that is the kind of regression a unit
// test on the service underneath cannot catch.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

const {
  verifyMock,
  isConfiguredMock,
  findManyMock,
  findUniqueMock,
  updateMock,
  auditMock,
  caseAccessSpy,
  denyCaseAccess,
} = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  isConfiguredMock: vi.fn(),
  findManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
  auditMock: vi.fn(),
  caseAccessSpy: vi.fn(),
  denyCaseAccess: { value: false },
}));

vi.mock("@prisma/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PrismaClient: vi.fn(() => ({
    checklistFundLine: {
      findMany: findManyMock,
      findUnique: findUniqueMock,
      update: updateMock,
      create: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: auditMock },
    $transaction: vi.fn(),
  })),
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "user-1", email: "ca@fh.co.uk", role: "CA_TEAM", name: "CA" };
    next();
  },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/requireCaseAccess", () => ({
  requireCaseAccess: (req: any, res: any, next: any) => {
    caseAccessSpy(req.params.caseId);
    if (denyCaseAccess.value) return res.status(403).json({ error: "Insufficient permissions" });
    next();
  },
}));

vi.mock("../services/fundVerification", () => ({
  verifyCaseFundLines: verifyMock,
  isVerificationConfigured: isConfiguredMock,
}));

import { fundLineRoutes } from "./fundLines";

const app = express();
app.use(express.json());
app.use("/api/cases", fundLineRoutes);

const CASE = "case-1";
const LINE = "line-1";

const summary = {
  caseId: CASE,
  total: 3,
  checked: 2,
  amber: 1,
  red: 2,
  skipped: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  denyCaseAccess.value = false;
  isConfiguredMock.mockReturnValue(true);
});

describe("POST /:caseId/fund-lines/verify", () => {
  it("returns the summary and the refreshed rows", async () => {
    verifyMock.mockResolvedValueOnce(summary);
    findManyMock.mockResolvedValueOnce([{ id: LINE, fundName: "RLS Deposit Pn" }]);

    const res = await request(app).post(`/api/cases/${CASE}/fund-lines/verify`).send();

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual(summary);
    expect(res.body.fundLines).toHaveLength(1);
    expect(verifyMock).toHaveBeenCalledWith(CASE, "user-1");
  });

  it("is 503 when verification is not configured on this environment", async () => {
    isConfiguredMock.mockReturnValue(false);

    const res = await request(app).post(`/api/cases/${CASE}/fund-lines/verify`).send();

    expect(res.status).toBe(503);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  // An upstream outage must not read as "we checked these and they failed".
  it("is 502 when the fund data cannot be reached", async () => {
    verifyMock.mockRejectedValueOnce(new Error("ECONNREFUSED 10.0.0.1:5432"));

    const res = await request(app).post(`/api/cases/${CASE}/fund-lines/verify`).send();

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/nothing was changed/i);
  });

  it("does not leak the upstream error to the caller", async () => {
    verifyMock.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED fund-db.postgres.database.azure.com:5432"),
    );

    const res = await request(app).post(`/api/cases/${CASE}/fund-lines/verify`).send();

    expect(JSON.stringify(res.body)).not.toMatch(/postgres|azure|ECONNREFUSED/i);
  });

  it("is refused when the caller has no access to the case", async () => {
    denyCaseAccess.value = true;

    const res = await request(app).post(`/api/cases/${CASE}/fund-lines/verify`).send();

    expect(res.status).toBe(403);
    expect(caseAccessSpy).toHaveBeenCalledWith(CASE);
    expect(verifyMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /:caseId/fund-lines/:lineId/source", () => {
  const verifiedLine = {
    id: LINE,
    caseId: CASE,
    fundName: "RLS Deposit Pn",
    isinSedolCiti: "0783248",
    resolvedIsin: "GB0007832487",
    verifiedAt: new Date("2026-09-22T10:00:00Z"),
  };

  it("records the choice and audits it", async () => {
    findUniqueMock.mockResolvedValueOnce(verifiedLine);
    updateMock.mockResolvedValueOnce({ ...verifiedLine, priceSource: "CEDING" });

    const res = await request(app)
      .patch(`/api/cases/${CASE}/fund-lines/${LINE}/source`)
      .send({ priceSource: "CEDING" });

    expect(res.status).toBe(200);
    expect(updateMock.mock.calls[0][0].data).toMatchObject({
      priceSource: "CEDING",
      editedById: "user-1",
    });
    expect(auditMock.mock.calls[0][0].data.metadata.reason).toBe("verification-source-choice");
  });

  it("accepts several fields at once", async () => {
    findUniqueMock.mockResolvedValueOnce(verifiedLine);
    updateMock.mockResolvedValueOnce(verifiedLine);

    const res = await request(app)
      .patch(`/api/cases/${CASE}/fund-lines/${LINE}/source`)
      .send({ fundNameSource: "LOOKUP", priceSource: "CEDING", ocfSource: "CEDING" });

    expect(res.status).toBe(200);
    expect(Object.keys(updateMock.mock.calls[0][0].data)).toEqual(
      expect.arrayContaining(["fundNameSource", "priceSource", "ocfSource"]),
    );
  });

  it("rejects a value outside the two sources", async () => {
    const res = await request(app)
      .patch(`/api/cases/${CASE}/fund-lines/${LINE}/source`)
      .send({ priceSource: "SOMEWHERE_ELSE" });

    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects an empty body rather than writing nothing silently", async () => {
    const res = await request(app)
      .patch(`/api/cases/${CASE}/fund-lines/${LINE}/source`)
      .send({});

    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("is 404 for a line that does not exist", async () => {
    findUniqueMock.mockResolvedValueOnce(null);

    const res = await request(app)
      .patch(`/api/cases/${CASE}/fund-lines/${LINE}/source`)
      .send({ priceSource: "CEDING" });

    expect(res.status).toBe(404);
  });

  // The guard scopes the CASE; the line must be checked against it separately,
  // or a caller with access to one case could edit another case's holding.
  it("is 404 for a line belonging to a different case", async () => {
    findUniqueMock.mockResolvedValueOnce({ ...verifiedLine, caseId: "someone-elses-case" });

    const res = await request(app)
      .patch(`/api/cases/${CASE}/fund-lines/${LINE}/source`)
      .send({ priceSource: "CEDING" });

    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("is 409 on a holding that has not been verified", async () => {
    findUniqueMock.mockResolvedValueOnce({ ...verifiedLine, verifiedAt: null });

    const res = await request(app)
      .patch(`/api/cases/${CASE}/fund-lines/${LINE}/source`)
      .send({ priceSource: "CEDING" });

    expect(res.status).toBe(409);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("is refused when the caller has no access to the case", async () => {
    denyCaseAccess.value = true;

    const res = await request(app)
      .patch(`/api/cases/${CASE}/fund-lines/${LINE}/source`)
      .send({ priceSource: "CEDING" });

    expect(res.status).toBe(403);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});
