import { describe, it, expect, beforeEach, vi } from "vitest";

// Mocked before importing the module under test: it instantiates a
// PrismaClient at import time, and getTask would otherwise hit Zoho.
const {
  findUniqueMock,
  updateMock,
  auditCreateMock,
  getTaskMock,
  findManyMock,
  updateManyMock,
  auditCreateManyMock,
  findTaskIdsByOwnerMock,
  findZohoUserByEmailMock,
} = vi.hoisted(
  () => ({
    findUniqueMock: vi.fn(),
    updateMock: vi.fn(),
    auditCreateMock: vi.fn(),
    getTaskMock: vi.fn(),
    findManyMock: vi.fn(),
    updateManyMock: vi.fn(),
    auditCreateManyMock: vi.fn(),
    findTaskIdsByOwnerMock: vi.fn(),
    findZohoUserByEmailMock: vi.fn(),
  }),
);

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(() => ({
    case: {
      findUnique: findUniqueMock,
      update: updateMock,
      findMany: findManyMock,
      updateMany: updateManyMock,
    },
    auditLog: { create: auditCreateMock, createMany: auditCreateManyMock },
  })),
}));

vi.mock("./zohoCrm", () => ({
  getTask: getTaskMock,
  findTaskIdsByOwner: findTaskIdsByOwnerMock,
  findZohoUserByEmail: findZohoUserByEmailMock,
}));

import {
  repairCaseOwnerFromZoho,
  reconcileOwnedCasesAtLogin,
} from "./caseOwnerSync";

// The cooldown and budget maps are module-level and persist for the whole
// file, so every test uses its own user/case ids rather than resetting them.
let seq = 0;
const ids = () => {
  seq += 1;
  return { userId: `user-${seq}`, caseId: `case-${seq}` };
};

const zohoTask = (ownerEmail: string | null) => ({
  data: [ownerEmail === null ? {} : { Owner: { email: ownerEmail } }],
});

beforeEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
  auditCreateMock.mockReset();
  getTaskMock.mockReset();
  findManyMock.mockReset();
  updateManyMock.mockReset();
  auditCreateManyMock.mockReset();
  findTaskIdsByOwnerMock.mockReset();
  findZohoUserByEmailMock.mockReset();
});

describe("repairCaseOwnerFromZoho", () => {
  it("adopts Zoho's answer when it names the requesting user as the owner", async () => {
    const { userId, caseId } = ids();
    findUniqueMock.mockResolvedValueOnce({
      id: caseId,
      zohoTaskId: "task-1",
      assignedToId: "someone-else",
    });
    getTaskMock.mockResolvedValueOnce(zohoTask("owner@fh.co.uk"));

    const granted = await repairCaseOwnerFromZoho(caseId, {
      id: userId,
      email: "owner@fh.co.uk",
    });

    expect(granted).toBe(true);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: caseId },
      data: { assignedToId: userId },
    });
  });

  it("matches the owner email case-insensitively", async () => {
    const { userId, caseId } = ids();
    findUniqueMock.mockResolvedValueOnce({
      id: caseId,
      zohoTaskId: "task-1",
      assignedToId: null,
    });
    getTaskMock.mockResolvedValueOnce(zohoTask("Owner@FH.co.uk"));

    const granted = await repairCaseOwnerFromZoho(caseId, {
      id: userId,
      email: "owner@fh.CO.UK",
    });

    expect(granted).toBe(true);
  });

  it("records the reassignment in the audit trail", async () => {
    const { userId, caseId } = ids();
    findUniqueMock.mockResolvedValueOnce({
      id: caseId,
      zohoTaskId: "task-9",
      assignedToId: "previous-owner",
    });
    getTaskMock.mockResolvedValueOnce(zohoTask("owner@fh.co.uk"));

    await repairCaseOwnerFromZoho(caseId, {
      id: userId,
      email: "owner@fh.co.uk",
    });

    const entry = auditCreateMock.mock.calls[0][0].data;
    expect(entry.action).toBe("CASE_ASSIGNED");
    expect(entry.caseId).toBe(caseId);
    expect(entry.oldValue).toBe("previous-owner");
    expect(entry.newValue).toBe(userId);
    expect(entry.metadata.reason).toBe("zoho-owner-reconciliation");
  });

  // ── Must not widen access ───────────────────────────────────────────
  it("refuses, and writes nothing, when Zoho names a different owner", async () => {
    const { userId, caseId } = ids();
    findUniqueMock.mockResolvedValueOnce({
      id: caseId,
      zohoTaskId: "task-1",
      assignedToId: "someone-else",
    });
    getTaskMock.mockResolvedValueOnce(zohoTask("rightful.owner@fh.co.uk"));

    const granted = await repairCaseOwnerFromZoho(caseId, {
      id: userId,
      email: "intruder@fh.co.uk",
    });

    expect(granted).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("refuses when Zoho returns no owner email (never clears an assignment)", async () => {
    const { userId, caseId } = ids();
    findUniqueMock.mockResolvedValueOnce({
      id: caseId,
      zohoTaskId: "task-1",
      assignedToId: "someone-else",
    });
    getTaskMock.mockResolvedValueOnce(zohoTask(null));

    const granted = await repairCaseOwnerFromZoho(caseId, {
      id: userId,
      email: "owner@fh.co.uk",
    });

    expect(granted).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("refuses a case that did not come from CRM (no zohoTaskId), without calling Zoho", async () => {
    const { userId, caseId } = ids();
    findUniqueMock.mockResolvedValueOnce({
      id: caseId,
      zohoTaskId: null,
      assignedToId: null,
    });

    const granted = await repairCaseOwnerFromZoho(caseId, {
      id: userId,
      email: "owner@fh.co.uk",
    });

    expect(granted).toBe(false);
    expect(getTaskMock).not.toHaveBeenCalled();
  });

  it("refuses a case id that does not exist", async () => {
    const { userId, caseId } = ids();
    findUniqueMock.mockResolvedValueOnce(null);

    const granted = await repairCaseOwnerFromZoho(caseId, {
      id: userId,
      email: "owner@fh.co.uk",
    });

    expect(granted).toBe(false);
    expect(getTaskMock).not.toHaveBeenCalled();
  });

  it("fails closed when Zoho errors — an outage must not widen access", async () => {
    const { userId, caseId } = ids();
    findUniqueMock.mockResolvedValueOnce({
      id: caseId,
      zohoTaskId: "task-1",
      assignedToId: "someone-else",
    });
    getTaskMock.mockRejectedValueOnce(new Error("Zoho 502"));

    const granted = await repairCaseOwnerFromZoho(caseId, {
      id: userId,
      email: "owner@fh.co.uk",
    });

    expect(granted).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });

  // ── Cost control ────────────────────────────────────────────────────
  it("does not re-ask Zoho for the same user and case within the cooldown", async () => {
    const { userId, caseId } = ids();
    findUniqueMock.mockResolvedValue({
      id: caseId,
      zohoTaskId: "task-1",
      assignedToId: "someone-else",
    });
    getTaskMock.mockResolvedValue(zohoTask("rightful.owner@fh.co.uk"));

    await repairCaseOwnerFromZoho(caseId, { id: userId, email: "a@fh.co.uk" });
    await repairCaseOwnerFromZoho(caseId, { id: userId, email: "a@fh.co.uk" });
    await repairCaseOwnerFromZoho(caseId, { id: userId, email: "a@fh.co.uk" });

    expect(getTaskMock).toHaveBeenCalledTimes(1);
  });

  it("stops calling Zoho once a user exhausts the attempt budget", async () => {
    const { userId } = ids();
    findUniqueMock.mockResolvedValue({
      id: "c",
      zohoTaskId: "task-1",
      assignedToId: "someone-else",
    });
    getTaskMock.mockResolvedValue(zohoTask("rightful.owner@fh.co.uk"));

    // Distinct case ids so the cooldown never applies — only the budget does.
    for (let i = 0; i < 40; i += 1) {
      await repairCaseOwnerFromZoho(`sweep-${userId}-${i}`, {
        id: userId,
        email: "prober@fh.co.uk",
      });
    }

    expect(getTaskMock.mock.calls.length).toBeLessThanOrEqual(20);
  });

});

describe("reconcileOwnedCasesAtLogin", () => {
  it("adopts Zoho's ownership for every case that disagrees", async () => {
    findZohoUserByEmailMock.mockResolvedValueOnce({ id: "zoho-user-1" });
    findTaskIdsByOwnerMock.mockResolvedValueOnce(["task-a", "task-b"]);
    findManyMock.mockResolvedValueOnce([
      { id: "case-a", assignedToId: "old-1", zohoTaskId: "task-a" },
      { id: "case-b", assignedToId: null, zohoTaskId: "task-b" },
    ]);

    const corrected = await reconcileOwnedCasesAtLogin({
      id: "user-1",
      email: "ca@fh.co.uk",
    });

    expect(corrected).toBe(2);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["case-a", "case-b"] } },
      data: { assignedToId: "user-1" },
    });
    // Only ever writes the signing-in user - never a third party, never null.
    expect(updateManyMock.mock.calls[0][0].data).toEqual({
      assignedToId: "user-1",
    });
  });

  it("queries only for cases that do not already point at the user", async () => {
    findZohoUserByEmailMock.mockResolvedValueOnce({ id: "zoho-user-1" });
    findTaskIdsByOwnerMock.mockResolvedValueOnce(["task-a"]);
    findManyMock.mockResolvedValueOnce([]);

    await reconcileOwnedCasesAtLogin({ id: "user-1", email: "ca@fh.co.uk" });

    expect(findManyMock.mock.calls[0][0].where).toEqual({
      zohoTaskId: { in: ["task-a"] },
      NOT: { assignedToId: "user-1" },
    });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("writes an audit entry per corrected case", async () => {
    findZohoUserByEmailMock.mockResolvedValueOnce({ id: "zoho-user-1" });
    findTaskIdsByOwnerMock.mockResolvedValueOnce(["task-a"]);
    findManyMock.mockResolvedValueOnce([
      { id: "case-a", assignedToId: "old-1", zohoTaskId: "task-a" },
    ]);

    await reconcileOwnedCasesAtLogin({ id: "user-1", email: "ca@fh.co.uk" });

    const entries = auditCreateManyMock.mock.calls[0][0].data;
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("CASE_ASSIGNED");
    expect(entries[0].oldValue).toBe("old-1");
    expect(entries[0].newValue).toBe("user-1");
    expect(entries[0].metadata.trigger).toBe("sign-in");
  });

  it("does nothing when the signing-in address is not a CRM user", async () => {
    // The appointed-representative case: someone whose CRM identity uses a
    // different email than the one they sign in with. Unaffected, not broken.
    findZohoUserByEmailMock.mockResolvedValueOnce(null);

    const corrected = await reconcileOwnedCasesAtLogin({
      id: "user-1",
      email: "someone@other-firm.co.uk",
    });

    expect(corrected).toBe(0);
    expect(findTaskIdsByOwnerMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("does nothing when the user owns no tasks", async () => {
    findZohoUserByEmailMock.mockResolvedValueOnce({ id: "zoho-user-1" });
    findTaskIdsByOwnerMock.mockResolvedValueOnce([]);

    const corrected = await reconcileOwnedCasesAtLogin({
      id: "user-1",
      email: "ca@fh.co.uk",
    });

    expect(corrected).toBe(0);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("swallows Zoho failures so a sign-in can never be blocked by them", async () => {
    findZohoUserByEmailMock.mockResolvedValueOnce({ id: "zoho-user-1" });
    findTaskIdsByOwnerMock.mockRejectedValueOnce(new Error("COQL 500"));

    const corrected = await reconcileOwnedCasesAtLogin({
      id: "user-1",
      email: "ca@fh.co.uk",
    });

    expect(corrected).toBe(0);
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});
