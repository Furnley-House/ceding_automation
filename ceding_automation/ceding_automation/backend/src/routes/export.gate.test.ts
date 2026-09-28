// The verification gate on the export endpoint.
//
// Stage 6 gates the hand-off, but the stage stepper lets a CA jump straight
// to stage 9, and the figures reach CRM from HERE. So the check has to be on
// the server, and these cover the two ways it could be wrong: letting
// unchecked figures through silently, or locking a firm out of exporting.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

const {
  findUniqueMock,
  fundLineFindManyMock,
  auditMock,
  isConfiguredMock,
  uploadMock,
  resolveFolderMock,
  updatePlanMock,
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  fundLineFindManyMock: vi.fn(),
  auditMock: vi.fn(),
  isConfiguredMock: vi.fn(),
  uploadMock: vi.fn(),
  resolveFolderMock: vi.fn(),
  updatePlanMock: vi.fn(),
}));

vi.mock("@prisma/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PrismaClient: vi.fn(() => ({
    case: { findUnique: findUniqueMock, update: vi.fn() },
    checklistFundLine: { findMany: fundLineFindManyMock },
    auditLog: { create: auditMock },
  })),
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "user-1", email: "ca@fh.co.uk", role: "CA_TEAM", name: "Revathy S" };
    next();
  },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireCaseAccess", () => ({
  requireCaseAccess: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../services/fundVerification", () => ({
  isVerificationConfigured: isConfiguredMock,
}));
vi.mock("../services/workdrive", () => ({
  uploadToWorkDrive: uploadMock,
  resolveCaseFolderId: resolveFolderMock,
  WorkDriveFolderResolutionError: class extends Error {},
}));
vi.mock("../services/zohoCrm", () => ({
  updatePlanRecord: updatePlanMock,
  findPlanRecordByPolicyRef: vi.fn(),
  findPlanRecordById: vi.fn().mockResolvedValue(null),
  findProviderRecordByName: vi.fn(),
  mapPlanTypeToZoho: (s: string) => s,
  planProviderField: () => "Provider",
}));

import { exportRoutes } from "./export";

const app = express();
app.use("/api/cases", exportRoutes);

const CASE = "case-1";
const post = (fields: Record<string, string> = {}) => {
  let r = request(app)
    .post(`/api/cases/${CASE}/complete-export`)
    .attach("file", Buffer.from("xlsx"), "export.xlsx")
    .field("fileName", "export.xlsx");
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r;
};

beforeEach(() => {
  vi.clearAllMocks();
  isConfiguredMock.mockReturnValue(true);
  findUniqueMock.mockResolvedValue({
    id: CASE,
    caseRef: "FH-2026-000004",
    planType: "PENSION",
    policyRef: "73737",
    planStartDate: null,
    clientZohoId: "contact-1",
    zohoCaseId: null,
    zohoOwnerId: null,
    zohoClientOwnerIds: [],
    zohoParaplannerId: null,
    zohoProviderRecordId: null,
    zohoSyncedAt: null,
    provider: { name: "Royal London" },
    checklistFields: [],
  });
  resolveFolderMock.mockResolvedValue({ folderId: "folder-1" });
  uploadMock.mockResolvedValue({ id: "f1", name: "export.xlsx", permalink: "http://wd" });
});

describe("export verification gate", () => {
  it("refuses when a holding has not been checked, and writes nothing", async () => {
    fundLineFindManyMock.mockResolvedValue([
      { id: "l1", fundName: "Phoenix AL International Pn", verifiedAt: new Date() },
      { id: "l2", fundName: "RLS Global Senior ABS Pn", verifiedAt: null },
    ]);

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HOLDINGS_NEED_CONFIRMATION");
    expect(res.body.unverified).toBe(1);
    // Named, so the CA knows which one to go and check.
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0].kind).toBe("unverified");
    expect(res.body.issues[0].holdings).toEqual(["RLS Global Senior ABS Pn"]);
    // Refused BEFORE anything leaves the building.
    expect(uploadMock).not.toHaveBeenCalled();
    expect(updatePlanMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("exports when every holding has been checked", async () => {
    fundLineFindManyMock.mockResolvedValue([
      { id: "l1", fundName: "Phoenix", verifiedAt: new Date() },
    ]);
    const res = await post();
    expect(res.status).toBe(200);
    expect(uploadMock).toHaveBeenCalled();
  });

  it("exports a case that has no holdings at all", async () => {
    fundLineFindManyMock.mockResolvedValue([]);
    const res = await post();
    expect(res.status).toBe(200);
  });

  // An FE outage, or a fund line predating this feature, must not leave a
  // firm unable to export. The CA can always proceed by confirming.
  it("exports unchecked holdings once the CA confirms", async () => {
    fundLineFindManyMock.mockResolvedValue([
      { id: "l1", fundName: "RLS Global Senior ABS Pn", verifiedAt: null },
    ]);

    const res = await post({ confirmUnverified: "true" });

    expect(res.status).toBe(200);
    expect(res.body.gateOverride).toBe(true);
    expect(uploadMock).toHaveBeenCalled();
  });

  it("records who overrode it, and which holdings", async () => {
    fundLineFindManyMock.mockResolvedValue([
      { id: "l1", fundName: "RLS Global Senior ABS Pn", verifiedAt: null },
    ]);

    await post({ confirmUnverified: "true" });

    const audit = auditMock.mock.calls[0][0].data;
    expect(audit.userId).toBe("user-1");
    expect(audit.metadata.gateOverride).toBe(true);
    expect(audit.metadata.gateOverrideIssues).toEqual([
      { kind: "unverified", holdings: ["RLS Global Senior ABS Pn"] },
    ]);
  });

  it("does not flag an override on a fully verified export", async () => {
    fundLineFindManyMock.mockResolvedValue([
      { id: "l1", fundName: "Phoenix", verifiedAt: new Date() },
    ]);
    const res = await post({ confirmUnverified: "true" });
    expect(res.body.gateOverride).toBe(false);
  });

  // Blocking an environment that cannot verify would leave no path but to
  // override on every export, which teaches people to click through.
  it("does not gate at all where verification is not configured", async () => {
    isConfiguredMock.mockReturnValue(false);
    fundLineFindManyMock.mockResolvedValue([
      { id: "l1", fundName: "Phoenix", verifiedAt: null },
    ]);

    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body.gateOverride).toBe(false);
  });

  it("treats anything other than an explicit true as no confirmation", async () => {
    fundLineFindManyMock.mockResolvedValue([
      { id: "l1", fundName: "Phoenix", verifiedAt: null },
    ]);
    const res = await post({ confirmUnverified: "yes" });
    expect(res.status).toBe(409);
  });
});

// A pence price pushed as pounds lands in CRM at 100x, on a figure that
// looked right on the statement it was copied from. Nobody re-checks it.
describe("export price-scale gate", () => {
  const verified = (over: Record<string, unknown>) => ({
    id: "l1",
    fundName: "Vanguard FTSE Global All Cap",
    verifiedAt: new Date(),
    priceSource: "CEDING",
    pricePerUnit: null,
    resolvedUnitPrice: null,
    ...over,
  });

  it("refuses a checklist price 100x above the reference", async () => {
    fundLineFindManyMock.mockResolvedValue([
      verified({ pricePerUnit: "137.68", resolvedUnitPrice: "1.3768" }),
    ]);

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HOLDINGS_NEED_CONFIRMATION");
    expect(res.body.issues[0].kind).toBe("price-scale");
    expect(res.body.issues[0].holdings).toEqual([
      "Vanguard FTSE Global All Cap — checklist 137.68, reference 1.3768 (100x too high)",
    ]);
    expect(updatePlanMock).not.toHaveBeenCalled();
  });

  it("refuses a misplaced decimal point the other way", async () => {
    fundLineFindManyMock.mockResolvedValue([
      verified({ pricePerUnit: "0.013768", resolvedUnitPrice: "1.3768" }),
    ]);
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.issues[0].holdings[0]).toContain("100x too low");
  });

  // The toggle is the fix. Having used it, the CA should not be asked again.
  it("allows it once the reference price is the chosen one", async () => {
    fundLineFindManyMock.mockResolvedValue([
      verified({
        priceSource: "LOOKUP",
        pricePerUnit: "137.68",
        resolvedUnitPrice: "1.3768",
      }),
    ]);
    const res = await post();
    expect(res.status).toBe(200);
  });

  it("ignores a genuine price difference that is not a clean 100x", async () => {
    fundLineFindManyMock.mockResolvedValue([
      verified({ pricePerUnit: "1.50", resolvedUnitPrice: "1.3768" }),
    ]);
    const res = await post();
    expect(res.status).toBe(200);
  });

  it("ignores a holding with no reference price to compare against", async () => {
    fundLineFindManyMock.mockResolvedValue([
      verified({ pricePerUnit: "137.68", resolvedUnitPrice: null }),
    ]);
    const res = await post();
    expect(res.status).toBe(200);
  });

  it("exports anyway once the CA confirms, and records what they were shown", async () => {
    fundLineFindManyMock.mockResolvedValue([
      verified({ pricePerUnit: "137.68", resolvedUnitPrice: "1.3768" }),
    ]);

    const res = await post({ confirmUnverified: "true" });

    expect(res.status).toBe(200);
    const audit = auditMock.mock.calls[0][0].data;
    expect(audit.metadata.gateOverrideIssues[0].kind).toBe("price-scale");
  });

  // Both wrong at once: one dialog, both reasons, nothing hidden.
  it("reports an unverified holding and a scale problem together", async () => {
    fundLineFindManyMock.mockResolvedValue([
      verified({ id: "l1", pricePerUnit: "137.68", resolvedUnitPrice: "1.3768" }),
      verified({ id: "l2", fundName: "RLS Global Senior ABS Pn", verifiedAt: null }),
    ]);

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body.issues.map((i: { kind: string }) => i.kind)).toEqual([
      "unverified",
      "price-scale",
    ]);
  });
});
