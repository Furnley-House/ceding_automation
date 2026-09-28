import { describe, it, expect, beforeEach, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  createManualContributionTransaction,
  setContributionNotApplicable,
  ContributionNotFoundError,
  type ContributionsPrismaLike,
} from "./contributionsService";

// ── Test scaffolding ─────────────────────────────────────────────────────
// Dependency-injection over module-mocking: the service accepts a
// Prisma-like slice, tests pass a plain object of vi.fn stubs. Simpler,
// no vi.hoisted dance, no shared module state between tests.

function makeMockDb() {
  const contribFindFirst = vi.fn();
  const contribUpdate = vi.fn();
  const txFindMany = vi.fn();
  const txUpdateMany = vi.fn();
  const txCreate = vi.fn();
  const auditCreate = vi.fn();

  const tx = {
    checklistContribution: { findFirst: contribFindFirst, update: contribUpdate },
    contributionTransaction: {
      findMany: txFindMany,
      updateMany: txUpdateMany,
      create: txCreate,
    },
    auditLog: { create: auditCreate },
  };

  const $transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

  const db = {
    $transaction,
    ...tx,
  } as unknown as ContributionsPrismaLike;

  return {
    db,
    contribFindFirst,
    contribUpdate,
    txFindMany,
    txUpdateMany,
    txCreate,
    auditCreate,
    $transaction,
  };
}

const CONTRIB_ROW = {
  id: "contrib-1",
  position: 1,
  taxYearLabel: "2025/26",
  employerNotApplicableAt: null,
  personalNotApplicableAt: null,
};

function txRow(overrides: {
  id?: string;
  source?: "AI" | "MANUAL";
  amount?: string;
  description?: string;
  date?: Date | null;
} = {}) {
  return {
    id: overrides.id ?? "tx-existing",
    source: overrides.source ?? "AI",
    amount: new Prisma.Decimal(overrides.amount ?? "1234.56"),
    description: overrides.description ?? "Reg Pension Contribution (Employer)",
    // Explicit-null-preserving check — `overrides.date ?? default` would
    // swallow an explicit null (nullish coalescing triggers on null too),
    // and the MANUAL-retype test relies on being able to pass date: null.
    date: overrides.date !== undefined ? overrides.date : new Date("2025-09-15T00:00:00Z"),
  };
}

function stubCreatedRow(overrides: {
  id?: string;
  contributionId?: string;
  type?: "EMPLOYER" | "PERSONAL";
  amount?: string;
} = {}) {
  return {
    id: overrides.id ?? "tx-new",
    contributionId: overrides.contributionId ?? "contrib-1",
    type: overrides.type ?? "EMPLOYER",
    amount: new Prisma.Decimal(overrides.amount ?? "5000.00"),
    description: "Manual entry",
    source: "MANUAL" as const,
    createdAt: new Date("2026-09-07T12:00:00Z"),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("createManualContributionTransaction — fresh cell (no prior children)", () => {
  it("creates one MANUAL, supersedes zero, writes audit with supersededCount=0", async () => {
    const { db, contribFindFirst, txFindMany, txUpdateMany, txCreate, auditCreate, $transaction } = makeMockDb();
    contribFindFirst.mockResolvedValueOnce(CONTRIB_ROW);
    txFindMany.mockResolvedValueOnce([]);
    txUpdateMany.mockResolvedValueOnce({ count: 0 });
    txCreate.mockResolvedValueOnce(stubCreatedRow());
    auditCreate.mockResolvedValueOnce({});

    const result = await createManualContributionTransaction(db, {
      caseId: "case-1",
      contributionId: "contrib-1",
      type: "EMPLOYER",
      amount: new Prisma.Decimal("5000.00"),
      userId: "user-1",
    });

    expect(result.supersededCount).toBe(0);
    expect(result.transaction.type).toBe("EMPLOYER");
    expect(result.transaction.source).toBe("MANUAL");
    expect(result.transaction.description).toBe("Manual entry");

    // Atomicity: everything happened inside the $transaction callback.
    expect($transaction).toHaveBeenCalledOnce();

    // The updateMany fired even though there was nothing to supersede
    // — cheaper than an extra count() query and semantically correct.
    expect(txUpdateMany).toHaveBeenCalledWith({
      where: { contributionId: "contrib-1", type: "EMPLOYER", supersededAt: null },
      data: { supersededAt: expect.any(Date) },
    });

    // MANUAL row inserted with the expected shape (null date, null
    // documentId — the "honest > made-up" rule).
    const createArg = txCreate.mock.calls[0][0].data;
    expect(createArg.source).toBe("MANUAL");
    expect(createArg.description).toBe("Manual entry");
    expect(createArg.date).toBeUndefined();
    expect(createArg.documentId).toBeUndefined();
    expect(createArg.sourcePage).toBeUndefined();
    expect(createArg.sourceRef).toBeUndefined();

    // Audit written with self-contained metadata.
    const auditArg = auditCreate.mock.calls[0][0].data;
    expect(auditArg.action).toBe("CONTRIBUTION_TRANSACTION_ADDED");
    expect(auditArg.source).toBe("MANUAL");
    expect(auditArg.caseId).toBe("case-1");
    expect(auditArg.userId).toBe("user-1");
    expect(auditArg.metadata.supersededCount).toBe(0);
    expect(auditArg.metadata.supersededDetails).toEqual([]);
    expect(auditArg.metadata.type).toBe("EMPLOYER");
    expect(auditArg.metadata.position).toBe(1);
    expect(auditArg.metadata.taxYearLabel).toBe("2025/26");
  });
});

describe("createManualContributionTransaction — cell with prior AI children", () => {
  it("supersedes 3 AI rows, creates one MANUAL, audit records what was replaced", async () => {
    const { db, contribFindFirst, txFindMany, txUpdateMany, txCreate, auditCreate } = makeMockDb();
    contribFindFirst.mockResolvedValueOnce(CONTRIB_ROW);
    const aiRows = [
      txRow({ id: "ai-1", source: "AI", amount: "1000.00", description: "Reg Contribution (Employer)" }),
      txRow({ id: "ai-2", source: "AI", amount: "1500.00", description: "Reg Contribution (Employer)" }),
      txRow({ id: "ai-3", source: "AI", amount: "2500.00", description: "Reg Contribution (Employer)" }),
    ];
    txFindMany.mockResolvedValueOnce(aiRows);
    txUpdateMany.mockResolvedValueOnce({ count: 3 });
    txCreate.mockResolvedValueOnce(stubCreatedRow({ amount: "6000.00" }));
    auditCreate.mockResolvedValueOnce({});

    const result = await createManualContributionTransaction(db, {
      caseId: "case-1",
      contributionId: "contrib-1",
      type: "EMPLOYER",
      amount: new Prisma.Decimal("6000.00"),
      userId: "user-1",
    });

    expect(result.supersededCount).toBe(3);
    const auditArg = auditCreate.mock.calls[0][0].data;
    expect(auditArg.metadata.supersededCount).toBe(3);
    expect(auditArg.metadata.supersededDetails).toHaveLength(3);
    expect(auditArg.metadata.supersededDetails[0]).toEqual({
      id: "ai-1",
      source: "AI",
      amount: "1000",
      description: "Reg Contribution (Employer)",
      date: "2025-09-15",
    });
  });
});

describe("createManualContributionTransaction — cell with prior MANUAL (retype)", () => {
  it("supersedes the previous MANUAL too (retype = replace, not accumulate)", async () => {
    // This asserts the supersede-ALL policy documented in the service.
    // If we ever narrow to strict-AI-only, this test flips to expect
    // supersededCount === 0 and a MANUAL row surviving alongside.
    const { db, contribFindFirst, txFindMany, txUpdateMany, txCreate, auditCreate } = makeMockDb();
    contribFindFirst.mockResolvedValueOnce(CONTRIB_ROW);
    txFindMany.mockResolvedValueOnce([
      txRow({ id: "manual-old", source: "MANUAL", amount: "5000.00", description: "Manual entry", date: null }),
    ]);
    txUpdateMany.mockResolvedValueOnce({ count: 1 });
    txCreate.mockResolvedValueOnce(stubCreatedRow({ amount: "6000.00" }));
    auditCreate.mockResolvedValueOnce({});

    const result = await createManualContributionTransaction(db, {
      caseId: "case-1",
      contributionId: "contrib-1",
      type: "EMPLOYER",
      amount: new Prisma.Decimal("6000.00"),
      userId: "user-1",
    });

    expect(result.supersededCount).toBe(1);

    // Crucially, the updateMany WHERE clause does NOT filter by source
    // — proving the supersede-ALL policy (a strict-AI-only variant
    // would have source: 'AI' in this where clause).
    const updateArg = txUpdateMany.mock.calls[0][0].where;
    expect(updateArg.source).toBeUndefined();

    const auditArg = auditCreate.mock.calls[0][0].data;
    expect(auditArg.metadata.supersededDetails[0].source).toBe("MANUAL");
    expect(auditArg.metadata.supersededDetails[0].date).toBeNull();
  });
});

describe("createManualContributionTransaction — cross-case protection", () => {
  it("throws ContributionNotFoundError when contribution belongs to a different case", async () => {
    const { db, contribFindFirst, txFindMany, txUpdateMany, txCreate, auditCreate } = makeMockDb();
    // findFirst returns null when the WHERE (id, caseId) doesn't match
    contribFindFirst.mockResolvedValueOnce(null);

    await expect(
      createManualContributionTransaction(db, {
        caseId: "case-1",
        contributionId: "contrib-from-another-case",
        type: "EMPLOYER",
        amount: new Prisma.Decimal("5000.00"),
        userId: "user-1",
      }),
    ).rejects.toBeInstanceOf(ContributionNotFoundError);

    // No writes must have happened after the guard fired.
    expect(txFindMany).not.toHaveBeenCalled();
    expect(txUpdateMany).not.toHaveBeenCalled();
    expect(txCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe("createManualContributionTransaction — type scoping", () => {
  it("only supersedes rows of the same type (EMPLOYER manual leaves PERSONAL rows alone)", async () => {
    const { db, contribFindFirst, txFindMany, txUpdateMany, txCreate, auditCreate } = makeMockDb();
    contribFindFirst.mockResolvedValueOnce(CONTRIB_ROW);
    txFindMany.mockResolvedValueOnce([]);
    txUpdateMany.mockResolvedValueOnce({ count: 0 });
    txCreate.mockResolvedValueOnce(stubCreatedRow({ type: "PERSONAL", amount: "3000.00" }));
    auditCreate.mockResolvedValueOnce({});

    await createManualContributionTransaction(db, {
      caseId: "case-1",
      contributionId: "contrib-1",
      type: "PERSONAL",
      amount: new Prisma.Decimal("3000.00"),
      userId: "user-1",
    });

    // Both the read-for-audit and the supersede filter narrow by type.
    expect(txFindMany.mock.calls[0][0].where.type).toBe("PERSONAL");
    expect(txUpdateMany.mock.calls[0][0].where.type).toBe("PERSONAL");
  });
});

// ── setContributionNotApplicable (H33-followup PR5) ──────────────────────

describe("setContributionNotApplicable", () => {
  it("setting on an empty cell writes the flag, supersedes nothing, and audits with supersededCount=0", async () => {
    const {
      db,
      contribFindFirst,
      contribUpdate,
      txFindMany,
      txUpdateMany,
      auditCreate,
    } = makeMockDb();
    contribFindFirst.mockResolvedValueOnce(CONTRIB_ROW);
    txFindMany.mockResolvedValueOnce([]);
    contribUpdate.mockResolvedValueOnce({});
    auditCreate.mockResolvedValueOnce({});

    const result = await setContributionNotApplicable(db, {
      caseId: "case-1",
      contributionId: "contrib-1",
      type: "EMPLOYER",
      on: true,
      userId: "user-1",
    });

    expect(result.on).toBe(true);
    expect(result.supersededCount).toBe(0);
    expect(result.notApplicableAt).toBeInstanceOf(Date);

    // No updateMany when there's nothing to supersede — avoids a
    // pointless write.
    expect(txUpdateMany).not.toHaveBeenCalled();

    // Parent row updated with the paired columns for this type only.
    const updateArg = contribUpdate.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "contrib-1" });
    expect(updateArg.data.employerNotApplicableAt).toBeInstanceOf(Date);
    expect(updateArg.data.employerNotApplicableById).toBe("user-1");
    // Other type untouched.
    expect(updateArg.data.personalNotApplicableAt).toBeUndefined();

    // Audit: shape mirrors CONTRIBUTION_TRANSACTION_ADDED with a flag.
    const auditArg = auditCreate.mock.calls[0][0].data;
    expect(auditArg.action).toBe("CONTRIBUTION_MARKED_NA");
    expect(auditArg.source).toBe("MANUAL");
    expect(auditArg.metadata.flag).toBe("set");
    expect(auditArg.metadata.supersededCount).toBe(0);
    expect(auditArg.metadata.supersededDetails).toEqual([]);
    expect(auditArg.metadata.type).toBe("EMPLOYER");
    expect(auditArg.metadata.taxYearLabel).toBe("2025/26");
  });

  it("setting on a cell with AI transactions atomically supersedes them and records their detail", async () => {
    const {
      db,
      contribFindFirst,
      contribUpdate,
      txFindMany,
      txUpdateMany,
      auditCreate,
    } = makeMockDb();
    contribFindFirst.mockResolvedValueOnce(CONTRIB_ROW);
    txFindMany.mockResolvedValueOnce([
      txRow({ id: "ai-1", source: "AI", amount: "1200.00" }),
      txRow({ id: "ai-2", source: "AI", amount: "800.00" }),
    ]);
    txUpdateMany.mockResolvedValueOnce({ count: 2 });
    contribUpdate.mockResolvedValueOnce({});
    auditCreate.mockResolvedValueOnce({});

    const result = await setContributionNotApplicable(db, {
      caseId: "case-1",
      contributionId: "contrib-1",
      type: "EMPLOYER",
      on: true,
      userId: "user-1",
    });

    expect(result.supersededCount).toBe(2);

    // Supersede-ALL narrowed by (contributionId, type, supersededAt IS NULL).
    expect(txUpdateMany).toHaveBeenCalledWith({
      where: { contributionId: "contrib-1", type: "EMPLOYER", supersededAt: null },
      data: { supersededAt: expect.any(Date) },
    });

    // Audit metadata carries the full supersededDetails so the trail
    // is self-contained.
    const auditArg = auditCreate.mock.calls[0][0].data;
    expect(auditArg.metadata.supersededCount).toBe(2);
    expect(auditArg.metadata.supersededDetails).toHaveLength(2);
    expect(auditArg.metadata.supersededDetails[0].id).toBe("ai-1");
    expect(auditArg.metadata.supersededDetails[0].source).toBe("AI");
    expect(auditArg.metadata.supersededDetails[0].amount).toBe("1200");
  });

  it("clearing nulls the flag columns and does NOT supersede anything (KI-05)", async () => {
    // Deliberate trade-off: clear leaves prior supersedes in place.
    const {
      db,
      contribFindFirst,
      contribUpdate,
      txFindMany,
      txUpdateMany,
      auditCreate,
    } = makeMockDb();
    contribFindFirst.mockResolvedValueOnce({
      ...CONTRIB_ROW,
      employerNotApplicableAt: new Date("2026-09-08T00:00:00Z"),
    });
    contribUpdate.mockResolvedValueOnce({});
    auditCreate.mockResolvedValueOnce({});

    const result = await setContributionNotApplicable(db, {
      caseId: "case-1",
      contributionId: "contrib-1",
      type: "EMPLOYER",
      on: false,
      userId: "user-1",
    });

    expect(result.on).toBe(false);
    expect(result.notApplicableAt).toBeNull();
    expect(result.supersededCount).toBe(0);

    // No read-for-audit or supersede on the clear path.
    expect(txFindMany).not.toHaveBeenCalled();
    expect(txUpdateMany).not.toHaveBeenCalled();

    // Parent columns nulled for this type only.
    const updateArg = contribUpdate.mock.calls[0][0];
    expect(updateArg.data.employerNotApplicableAt).toBeNull();
    expect(updateArg.data.employerNotApplicableById).toBeNull();

    // Audit reflects the clear.
    const auditArg = auditCreate.mock.calls[0][0].data;
    expect(auditArg.metadata.flag).toBe("cleared");
    expect(auditArg.newValue).toBe("N/A cleared");
  });

  it("PERSONAL type touches only the personal columns", async () => {
    const { db, contribFindFirst, contribUpdate, txFindMany, txUpdateMany, auditCreate } = makeMockDb();
    contribFindFirst.mockResolvedValueOnce(CONTRIB_ROW);
    txFindMany.mockResolvedValueOnce([]);
    contribUpdate.mockResolvedValueOnce({});
    auditCreate.mockResolvedValueOnce({});

    await setContributionNotApplicable(db, {
      caseId: "case-1",
      contributionId: "contrib-1",
      type: "PERSONAL",
      on: true,
      userId: "user-1",
    });

    const updateArg = contribUpdate.mock.calls[0][0];
    expect(updateArg.data.personalNotApplicableAt).toBeInstanceOf(Date);
    expect(updateArg.data.personalNotApplicableById).toBe("user-1");
    expect(updateArg.data.employerNotApplicableAt).toBeUndefined();

    // Supersede filter also narrows by PERSONAL.
    expect(txFindMany.mock.calls[0][0].where.type).toBe("PERSONAL");

    // Belt-and-braces: no updateMany when supersededCount=0.
    expect(txUpdateMany).not.toHaveBeenCalled();
  });

  it("throws ContributionNotFoundError on cross-case id", async () => {
    const { db, contribFindFirst } = makeMockDb();
    contribFindFirst.mockResolvedValueOnce(null);

    await expect(
      setContributionNotApplicable(db, {
        caseId: "case-1",
        contributionId: "contrib-from-another-case",
        type: "EMPLOYER",
        on: true,
        userId: "user-1",
      }),
    ).rejects.toBeInstanceOf(ContributionNotFoundError);
  });
});
