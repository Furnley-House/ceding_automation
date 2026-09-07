import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  applyContributionTransactions,
  type ApplyContributionsArgs,
  type WireContributionTotal,
  type WireContributionTransaction,
} from "./aiBffApply";

// DI-over-module-mocking, matching contributionsService.test.ts. The helper
// accepts an optional `tx` client of the ContributionsTx shape; tests pass a
// plain object of vi.fn stubs and read the call args back.

function makeMockTx(overrides?: {
  parentsInDb?: Array<{ id: string; position: number; taxYearLabel: string }>;
  manuallyOwnedCells?: Array<{ contributionId: string; type: "EMPLOYER" | "PERSONAL" }>;
  supersededCount?: number;
}) {
  const upsert = vi.fn(async (arg: {
    where: { caseId_position: { caseId: string; position: number } };
    create: Record<string, unknown> & { taxYearLabel: string };
    update: Record<string, unknown>;
  }) => ({
    id: `parent-${arg.where.caseId_position.position}`,
    position: arg.where.caseId_position.position,
    taxYearLabel: arg.create.taxYearLabel,
  }));
  const supersedeUpdateMany = vi
    .fn()
    .mockResolvedValueOnce({ count: overrides?.supersededCount ?? 0 });
  const findParents = vi
    .fn()
    .mockResolvedValueOnce(overrides?.parentsInDb ?? []);
  const findManual = vi
    .fn()
    .mockResolvedValueOnce(overrides?.manuallyOwnedCells ?? []);
  const createMany = vi.fn().mockResolvedValueOnce({ count: 0 });
  const auditCreate = vi.fn().mockResolvedValueOnce({});

  const tx = {
    checklistContribution: {
      upsert,
      findMany: findParents,
    },
    contributionTransaction: {
      updateMany: supersedeUpdateMany,
      findMany: findManual,
      createMany,
    },
    auditLog: { create: auditCreate },
  };
  return {
    tx: tx as unknown as ApplyContributionsArgs["tx"],
    upsert,
    supersedeUpdateMany,
    findParents,
    findManual,
    createMany,
    auditCreate,
  };
}

const CASE_ID = "case-1";
const DOC_ID = "doc-1";
const JOB_ID = "bff-abcd1234";

function total(overrides: Partial<WireContributionTotal> = {}): WireContributionTotal {
  return {
    position: overrides.position ?? 1,
    taxYearLabel: overrides.taxYearLabel ?? "2025/26",
    employerAiTotal: overrides.employerAiTotal ?? 5000,
    personalAiTotal: overrides.personalAiTotal ?? 1000,
  };
}

function txRow(overrides: Partial<WireContributionTransaction> = {}): WireContributionTransaction {
  return {
    type: overrides.type ?? "EMPLOYER",
    taxYearLabel: overrides.taxYearLabel ?? "2025/26",
    date: overrides.date !== undefined ? overrides.date : new Date("2025-09-15T00:00:00Z"),
    amount: overrides.amount ?? 500,
    description: overrides.description ?? "Reg Pension Contribution (Employer)",
    sourcePage: overrides.sourcePage ?? 3,
    sourceRef: overrides.sourceRef ?? "table-2",
    confidence: overrides.confidence ?? "HIGH",
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("applyContributionTransactions — empty payload", () => {
  it("returns all zeros and touches no db when both blocks are absent", async () => {
    const m = makeMockTx();
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      tx: m.tx,
    });
    expect(result).toEqual({
      parentsUpserted: 0,
      supersededPriorAiCount: 0,
      transactionsInserted: 0,
      cellsSkippedManuallyOwned: 0,
      transactionsSkippedNoParent: 0,
    });
    expect(m.upsert).not.toHaveBeenCalled();
    expect(m.supersedeUpdateMany).not.toHaveBeenCalled();
    expect(m.findParents).not.toHaveBeenCalled();
    expect(m.findManual).not.toHaveBeenCalled();
    expect(m.createMany).not.toHaveBeenCalled();
    // Empty is a true no-op — audit does not fire, so re-processing an
    // already-completed job doesn't leave a noisy trail.
    expect(m.auditCreate).not.toHaveBeenCalled();
  });

  it("same for both explicitly empty arrays", async () => {
    const m = makeMockTx();
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      transactions: [],
      totals: [],
      tx: m.tx,
    });
    expect(result.transactionsInserted).toBe(0);
    expect(m.auditCreate).not.toHaveBeenCalled();
  });
});

describe("applyContributionTransactions — happy path (fresh case)", () => {
  it("upserts parents, inserts transactions, writes one batch audit", async () => {
    const parents = [
      { id: "parent-1", position: 1, taxYearLabel: "2025/26" },
      { id: "parent-2", position: 2, taxYearLabel: "2024/25" },
    ];
    const m = makeMockTx({ parentsInDb: parents });

    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [
        total({ position: 1, taxYearLabel: "2025/26", employerAiTotal: 5000, personalAiTotal: 1000 }),
        total({ position: 2, taxYearLabel: "2024/25", employerAiTotal: 4800, personalAiTotal: 900 }),
      ],
      transactions: [
        txRow({ type: "EMPLOYER", taxYearLabel: "2025/26", amount: 500 }),
        txRow({ type: "EMPLOYER", taxYearLabel: "2025/26", amount: 500 }),
        txRow({ type: "PERSONAL", taxYearLabel: "2025/26", amount: 250 }),
        txRow({ type: "EMPLOYER", taxYearLabel: "2024/25", amount: 400 }),
      ],
      tx: m.tx,
    });

    expect(m.upsert).toHaveBeenCalledTimes(2);
    expect(m.supersedeUpdateMany).toHaveBeenCalledWith({
      where: { documentId: DOC_ID, source: "AI", supersededAt: null },
      data: { supersededAt: expect.any(Date) },
    });
    // All 4 transactions inserted, one createMany call.
    expect(m.createMany).toHaveBeenCalledOnce();
    const insertedRows = m.createMany.mock.calls[0][0].data;
    expect(insertedRows).toHaveLength(4);
    expect(insertedRows[0]).toMatchObject({
      contributionId: "parent-1",
      type: "EMPLOYER",
      source: "AI",
      documentId: DOC_ID,
      sourcePage: 3,
      sourceRef: "table-2",
    });
    expect(insertedRows[0].amount).toBeInstanceOf(Prisma.Decimal);

    expect(result).toEqual({
      parentsUpserted: 2,
      supersededPriorAiCount: 0,
      transactionsInserted: 4,
      cellsSkippedManuallyOwned: 0,
      transactionsSkippedNoParent: 0,
    });

    // One audit row for the batch (parity with applyFundLines).
    expect(m.auditCreate).toHaveBeenCalledOnce();
    const audit = m.auditCreate.mock.calls[0][0].data;
    expect(audit.action).toBe("CONTRIBUTION_TRANSACTION_ADDED");
    expect(audit.source).toBe("AI");
    expect(audit.metadata.transactionsInserted).toBe(4);
    expect(audit.metadata.parentsUpserted).toBe(2);
    expect(audit.metadata.skippedCells).toEqual([]);
  });
});

describe("applyContributionTransactions — parent upsert semantics", () => {
  it("update payload OMITS taxYearLabel so a CA relabel is not overwritten", async () => {
    const m = makeMockTx({
      parentsInDb: [{ id: "parent-1", position: 1, taxYearLabel: "6 April 2025 – 5 April 2026" }],
    });
    await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [total({ position: 1, taxYearLabel: "2025/26", employerAiTotal: 5000, personalAiTotal: 1000 })],
      tx: m.tx,
    });
    const upsertArg = m.upsert.mock.calls[0][0];
    // CREATE carries the pipeline label (seeds it for fresh parents).
    expect(upsertArg.create.taxYearLabel).toBe("2025/26");
    // UPDATE must not touch the label — CA authority preserved.
    expect(upsertArg.update.taxYearLabel).toBeUndefined();
    expect(upsertArg.update.employerAiTotal).toBeInstanceOf(Prisma.Decimal);
    expect(upsertArg.update.personalAiTotal).toBeInstanceOf(Prisma.Decimal);
  });
});

describe("applyContributionTransactions — prior AI rows from same document", () => {
  it("supersedes them and reports the count", async () => {
    const m = makeMockTx({
      parentsInDb: [{ id: "parent-1", position: 1, taxYearLabel: "2025/26" }],
      supersededCount: 5,
    });
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [total({ position: 1 })],
      transactions: [txRow()],
      tx: m.tx,
    });
    expect(result.supersededPriorAiCount).toBe(5);
    // The supersede where clause narrows to AI + non-superseded — the MANUAL
    // rows are UNTOUCHED, which is the whole preservation contract.
    const whereArg = m.supersedeUpdateMany.mock.calls[0][0].where;
    expect(whereArg.source).toBe("AI");
    expect(whereArg.supersededAt).toBeNull();
    expect(whereArg.documentId).toBe(DOC_ID);
  });
});

describe("applyContributionTransactions — manually-owned cells", () => {
  it("skips AI insertion into a cell with a non-superseded MANUAL row, but STILL writes the parent AiTotal", async () => {
    const parents = [{ id: "parent-1", position: 1, taxYearLabel: "2025/26" }];
    const m = makeMockTx({
      parentsInDb: parents,
      manuallyOwnedCells: [{ contributionId: "parent-1", type: "EMPLOYER" }],
    });

    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [total({ position: 1, employerAiTotal: 7777, personalAiTotal: 333 })],
      transactions: [
        txRow({ type: "EMPLOYER", amount: 500 }),
        txRow({ type: "EMPLOYER", amount: 700 }),
        txRow({ type: "PERSONAL", amount: 100 }),
      ],
      tx: m.tx,
    });

    // Parent AiTotal was still upserted — forensics preserved even for a
    // manually-owned cell (schema.prisma:employerAiTotal comment).
    expect(m.upsert).toHaveBeenCalledOnce();
    expect(m.upsert.mock.calls[0][0].create.employerAiTotal).toBeInstanceOf(Prisma.Decimal);

    // Only the PERSONAL row survives insertion — both EMPLOYER rows skipped.
    expect(m.createMany).toHaveBeenCalledOnce();
    const rows = m.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("PERSONAL");

    expect(result.transactionsInserted).toBe(1);
    expect(result.cellsSkippedManuallyOwned).toBe(1);

    // Audit records WHICH cell was held back, not just the count.
    const audit = m.auditCreate.mock.calls[0][0].data;
    expect(audit.metadata.skippedCells).toEqual([
      { contributionId: "parent-1", type: "EMPLOYER" },
    ]);
  });

  it("EMPLOYER-manual does not block PERSONAL-AI in the same parent row (cell = parent × type)", async () => {
    const m = makeMockTx({
      parentsInDb: [{ id: "parent-1", position: 1, taxYearLabel: "2025/26" }],
      manuallyOwnedCells: [{ contributionId: "parent-1", type: "EMPLOYER" }],
    });
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [total({ position: 1 })],
      transactions: [txRow({ type: "PERSONAL", amount: 100 })],
      tx: m.tx,
    });
    expect(result.transactionsInserted).toBe(1);
    expect(result.cellsSkippedManuallyOwned).toBe(0);
  });
});

describe("applyContributionTransactions — parent lookup fallback", () => {
  it("resolves a transaction via pipeline label→position when the DB label was CA-edited", async () => {
    // DB has parent at position 1 with a CA-edited label; pipeline sends
    // its own label "2025/26" for both the total and the transaction.
    // Direct label match fails; fallback via position succeeds.
    const m = makeMockTx({
      parentsInDb: [{ id: "parent-1", position: 1, taxYearLabel: "6 April 2025 – 5 April 2026" }],
    });
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [total({ position: 1, taxYearLabel: "2025/26" })],
      transactions: [txRow({ taxYearLabel: "2025/26" })],
      tx: m.tx,
    });
    expect(result.transactionsInserted).toBe(1);
    expect(result.transactionsSkippedNoParent).toBe(0);
    expect(m.createMany.mock.calls[0][0].data[0].contributionId).toBe("parent-1");
  });
});

describe("applyContributionTransactions — orphan transaction", () => {
  it("counts a transaction with no resolvable parent as skipped, does not throw", async () => {
    const m = makeMockTx({ parentsInDb: [] });
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [], // pipeline sent no totals AND DB has no parents
      transactions: [txRow({ taxYearLabel: "1999/2000" })],
      tx: m.tx,
    });
    expect(result.transactionsSkippedNoParent).toBe(1);
    expect(result.transactionsInserted).toBe(0);
    expect(m.createMany).not.toHaveBeenCalled();
    // Audit still fires — the fact that a transaction arrived at all is
    // worth recording so the anomaly is traceable.
    const audit = m.auditCreate.mock.calls[0][0].data;
    expect(audit.metadata.transactionsSkippedNoParent).toBe(1);
  });
});
