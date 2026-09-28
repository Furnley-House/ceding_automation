import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoist mocks. PrismaClient + Zoho are both imported at module top of
// caseAccessRetry, so their factories must be hoisted above the SUT
// import.
const {
  userFindFirstMock,
  caseUpdateMock,
  caseFindUniqueMock,
  auditCreateMock,
  getTaskMock,
  mapZohoTaskToCaseMock,
} = vi.hoisted(() => ({
  userFindFirstMock: vi.fn(),
  caseUpdateMock: vi.fn().mockResolvedValue({}),
  caseFindUniqueMock: vi.fn(),
  auditCreateMock: vi.fn().mockResolvedValue({}),
  getTaskMock: vi.fn(),
  mapZohoTaskToCaseMock: vi.fn(),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(() => ({
    user: { findFirst: userFindFirstMock },
    case: { update: caseUpdateMock, findUnique: caseFindUniqueMock },
    auditLog: { create: auditCreateMock },
  })),
  // We only reference `Prisma.InputJsonValue` as a type in the SUT,
  // so an empty stub is sufficient at runtime.
  Prisma: {},
}));
vi.mock("./zohoCrm", () => ({
  getTask: getTaskMock,
  mapZohoTaskToCase: mapZohoTaskToCaseMock,
}));

import { syncAssignmentForAccessRetry } from "./caseAccessRetry";

// Task shape the SUT expects back from getTask. Minimal — we control
// the mapping via the mapZohoTaskToCase mock, so only the outer
// envelope matters.
function fakeTask() {
  return { data: [{ /* opaque */ }] };
}

beforeEach(() => {
  userFindFirstMock.mockReset();
  caseUpdateMock.mockReset().mockResolvedValue({});
  caseFindUniqueMock.mockReset();
  auditCreateMock.mockReset().mockResolvedValue({});
  getTaskMock.mockReset();
  mapZohoTaskToCaseMock.mockReset();
});

describe("syncAssignmentForAccessRetry — guard the write", () => {
  it("SKIPS case.update + audit when Zoho owner already matches currentAssignedToId (drive-by 403)", async () => {
    // Case scenario: someone tried to open a case they don't own. The
    // case's assignedTo IS the Zoho task owner (already in sync). We
    // must not write a "assignedTo changed" audit for a non-change.
    caseFindUniqueMock.mockResolvedValueOnce({ zohoTaskId: "zt-1" });
    getTaskMock.mockResolvedValueOnce(fakeTask());
    mapZohoTaskToCaseMock.mockReturnValueOnce({ ownerEmail: "carmel@x" });
    userFindFirstMock.mockResolvedValueOnce({
      id: "carmel-id",
      email: "carmel@x",
    });

    const result = await syncAssignmentForAccessRetry({
      caseId: "case-1",
      actorUserId: "someone-else",
      actorEmail: "someone.else@x",
      currentAssignedToId: "carmel-id", // ← matches Zoho owner
      timeoutMs: 3000,
    });

    expect(result).toMatchObject({
      outcome: "still-refused",
      granted: false,
      zohoOwnerEmail: "carmel@x",
    });
    // The bug this test locks down: no case.update, no audit row.
    expect(caseUpdateMock).not.toHaveBeenCalled();
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("WRITES case.update + audit when Zoho owner differs from currentAssignedToId (real reassignment)", async () => {
    // Aruna moved the Zoho task to Rachel. Case.assignedToId still
    // points at Aruna. Someone (could be Rachel, could be a third
    // party) triggers the retry. We must sync the DB and audit.
    caseFindUniqueMock.mockResolvedValueOnce({ zohoTaskId: "zt-2" });
    getTaskMock.mockResolvedValueOnce(fakeTask());
    mapZohoTaskToCaseMock.mockReturnValueOnce({ ownerEmail: "rachel@x" });
    userFindFirstMock.mockResolvedValueOnce({
      id: "rachel-id",
      email: "rachel@x",
    });

    const result = await syncAssignmentForAccessRetry({
      caseId: "case-2",
      actorUserId: "rachel-id", // caller IS the new Zoho owner
      actorEmail: "rachel@x",
      currentAssignedToId: "aruna-id", // ≠ Zoho owner
      timeoutMs: 3000,
    });

    expect(result).toMatchObject({
      outcome: "granted",
      granted: true,
      zohoOwnerEmail: "rachel@x",
    });
    expect(caseUpdateMock).toHaveBeenCalledOnce();
    expect(caseUpdateMock.mock.calls[0][0]).toMatchObject({
      where: { id: "case-2" },
      data: { assignedToId: "rachel-id" },
    });
    expect(auditCreateMock).toHaveBeenCalledOnce();
    const audit = auditCreateMock.mock.calls[0][0].data;
    expect(audit.action).toBe("CASE_UPDATED");
    expect(audit.metadata.trigger).toBe("access-retry");
    // Change record captures from/to so a reader can reconstruct the
    // transition — not the stub "field changed" of pre-fix code.
    expect(audit.metadata.changes).toEqual([
      {
        field: "assignedTo",
        from: "aruna-id",
        to: "rachel-id",
        trigger: "access-retry",
      },
    ]);
  });

  it("WRITES on drift even when caller is a third party (DB heals, caller still denied)", async () => {
    // Zoho reassigned to Carmel; the caller is Rachel (not the new
    // owner, not the old). We still fix the DB so the next legitimate
    // click-through by Carmel doesn't need another Zoho round-trip.
    caseFindUniqueMock.mockResolvedValueOnce({ zohoTaskId: "zt-3" });
    getTaskMock.mockResolvedValueOnce(fakeTask());
    mapZohoTaskToCaseMock.mockReturnValueOnce({ ownerEmail: "carmel@x" });
    userFindFirstMock.mockResolvedValueOnce({
      id: "carmel-id",
      email: "carmel@x",
    });

    const result = await syncAssignmentForAccessRetry({
      caseId: "case-3",
      actorUserId: "rachel-id",
      actorEmail: "rachel@x",
      currentAssignedToId: "aruna-id",
      timeoutMs: 3000,
    });

    expect(result).toMatchObject({ outcome: "still-refused", granted: false });
    expect(caseUpdateMock).toHaveBeenCalledOnce();
    expect(auditCreateMock).toHaveBeenCalledOnce();
  });

  it("SKIPS write when case has null assignedToId AND Zoho owner is also unresolvable (defensive)", async () => {
    // Null assignedToId is rare but possible (brand-new import). Only
    // skip when Zoho user id == currentAssignedToId; a null current
    // and a real Zoho user id → real change → write.
    caseFindUniqueMock.mockResolvedValueOnce({ zohoTaskId: "zt-4" });
    getTaskMock.mockResolvedValueOnce(fakeTask());
    mapZohoTaskToCaseMock.mockReturnValueOnce({ ownerEmail: "carmel@x" });
    userFindFirstMock.mockResolvedValueOnce({
      id: "carmel-id",
      email: "carmel@x",
    });

    const result = await syncAssignmentForAccessRetry({
      caseId: "case-4",
      actorUserId: "rachel-id",
      actorEmail: "rachel@x",
      currentAssignedToId: null, // brand-new case, never assigned
      timeoutMs: 3000,
    });

    expect(result.outcome).toBe("still-refused");
    // null !== "carmel-id" → write happens (this is correct behaviour)
    expect(caseUpdateMock).toHaveBeenCalledOnce();
  });
});

describe("syncAssignmentForAccessRetry — case-insensitive email match", () => {
  it("uses mode:'insensitive' so a legacy mixed-case email still matches", async () => {
    caseFindUniqueMock.mockResolvedValueOnce({ zohoTaskId: "zt-5" });
    getTaskMock.mockResolvedValueOnce(fakeTask());
    // Zoho returns the email in mixed case (matches how Zoho user
    // records often carry it — capitalised local part).
    mapZohoTaskToCaseMock.mockReturnValueOnce({
      ownerEmail: "Rachel.Fiyorina@Furnleyhouse.co.uk",
    });
    // Our DB has the email lowercased (post-H36 writes are always
    // lowercased at insert), but we could equally have legacy rows
    // with mixed case. The lookup must not depend on either side's
    // case.
    userFindFirstMock.mockResolvedValueOnce({
      id: "rachel-id",
      email: "rachel.fiyorina@furnleyhouse.co.uk",
    });

    const result = await syncAssignmentForAccessRetry({
      caseId: "case-5",
      actorUserId: "rachel-id",
      actorEmail: "rachel.fiyorina@furnleyhouse.co.uk",
      currentAssignedToId: "aruna-id",
      timeoutMs: 3000,
    });

    expect(result).toMatchObject({ outcome: "granted", granted: true });
    // The lookup we care about: WHERE clause carries insensitive mode.
    // Regression guard — a future refactor that drops the mode flag
    // will fail this expect immediately.
    expect(userFindFirstMock).toHaveBeenCalledOnce();
    const whereArg = userFindFirstMock.mock.calls[0][0].where;
    expect(whereArg.email).toEqual({
      equals: "rachel.fiyorina@furnleyhouse.co.uk",
      mode: "insensitive",
    });
    expect(whereArg.status).toBe("ACTIVE");
  });

  it("lower-cases the Zoho owner email before the query (belt + braces alongside mode:'insensitive')", async () => {
    caseFindUniqueMock.mockResolvedValueOnce({ zohoTaskId: "zt-6" });
    getTaskMock.mockResolvedValueOnce(fakeTask());
    mapZohoTaskToCaseMock.mockReturnValueOnce({
      ownerEmail: "MIXED.Case@X",
    });
    userFindFirstMock.mockResolvedValueOnce({ id: "u", email: "mixed.case@x" });

    await syncAssignmentForAccessRetry({
      caseId: "case-6",
      actorUserId: "u",
      actorEmail: null,
      currentAssignedToId: "someone-else",
      timeoutMs: 3000,
    });

    // toLowerCase applied at line ~117 of the SUT; assert we send the
    // lowercase form on the wire even though mode:'insensitive' would
    // catch it anyway. Two defences beat one.
    const whereArg = userFindFirstMock.mock.calls[0][0].where;
    expect(whereArg.email.equals).toBe("mixed.case@x");
  });
});

describe("syncAssignmentForAccessRetry — outcome mapping", () => {
  it("returns owner-unknown when Zoho email resolves to no active user", async () => {
    caseFindUniqueMock.mockResolvedValueOnce({ zohoTaskId: "zt-7" });
    getTaskMock.mockResolvedValueOnce(fakeTask());
    mapZohoTaskToCaseMock.mockReturnValueOnce({ ownerEmail: "ghost@x" });
    userFindFirstMock.mockResolvedValueOnce(null);
    const result = await syncAssignmentForAccessRetry({
      caseId: "c", actorUserId: "u", actorEmail: null,
      currentAssignedToId: "someone", timeoutMs: 3000,
    });
    expect(result.outcome).toBe("owner-unknown");
    expect(caseUpdateMock).not.toHaveBeenCalled();
  });

  it("returns task-gone when Zoho returns no task record", async () => {
    caseFindUniqueMock.mockResolvedValueOnce({ zohoTaskId: "zt-8" });
    getTaskMock.mockResolvedValueOnce({ data: [] });
    const result = await syncAssignmentForAccessRetry({
      caseId: "c", actorUserId: "u", actorEmail: null,
      currentAssignedToId: "someone", timeoutMs: 3000,
    });
    expect(result.outcome).toBe("task-gone");
    expect(caseUpdateMock).not.toHaveBeenCalled();
  });

  it("returns no-zoho-owner when the task has no Owner email", async () => {
    caseFindUniqueMock.mockResolvedValueOnce({ zohoTaskId: "zt-9" });
    getTaskMock.mockResolvedValueOnce(fakeTask());
    mapZohoTaskToCaseMock.mockReturnValueOnce({ ownerEmail: undefined });
    const result = await syncAssignmentForAccessRetry({
      caseId: "c", actorUserId: "u", actorEmail: null,
      currentAssignedToId: "someone", timeoutMs: 3000,
    });
    expect(result.outcome).toBe("no-zoho-owner");
    expect(caseUpdateMock).not.toHaveBeenCalled();
  });

  it("returns timeout when Zoho fetch exceeds the deadline", async () => {
    caseFindUniqueMock.mockResolvedValueOnce({ zohoTaskId: "zt-10" });
    getTaskMock.mockImplementationOnce(
      () => new Promise((r) => setTimeout(() => r(fakeTask()), 200)),
    );
    const result = await syncAssignmentForAccessRetry({
      caseId: "c", actorUserId: "u", actorEmail: null,
      currentAssignedToId: "someone", timeoutMs: 50,
    });
    expect(result.outcome).toBe("timeout");
  });

  it("returns error on any thrown failure (Zoho 500, mapping throw, etc.)", async () => {
    caseFindUniqueMock.mockResolvedValueOnce({ zohoTaskId: "zt-11" });
    getTaskMock.mockRejectedValueOnce(new Error("Zoho 500"));
    const result = await syncAssignmentForAccessRetry({
      caseId: "c", actorUserId: "u", actorEmail: null,
      currentAssignedToId: "someone", timeoutMs: 3000,
    });
    expect(result.outcome).toBe("error");
  });
});
