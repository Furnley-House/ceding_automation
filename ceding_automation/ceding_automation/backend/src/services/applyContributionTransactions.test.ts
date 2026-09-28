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
//
// After the 2026-09-16 label-truth rewrite the mock surface changed:
//   - No upsert on checklistContribution — parents are matched by label
//     against a snapshot and updated in place. The AI path never creates
//     new parent rows.
//   - findMany on checklistContribution runs once (parent snapshot).
//   - auditLog.create may fire up to three times per call: one for the
//     TRANSACTION_ADDED batch, one each for the two orphan classes when
//     the counts are non-zero.

function makeMockTx(overrides?: {
  parentsInDb?: Array<{ id: string; position: number; taxYearLabel: string }>;
  manuallyOwnedCells?: Array<{ contributionId: string; type: "EMPLOYER" | "PERSONAL" }>;
  supersededCount?: number;
}) {
  const update = vi.fn(async (arg: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: arg.where.id,
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
  const auditCreate = vi.fn().mockResolvedValue({});

  const tx = {
    checklistContribution: {
      update,
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
    update,
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

function findAuditByAction(auditCreate: ReturnType<typeof vi.fn>, action: string) {
  return auditCreate.mock.calls
    .map((c) => c[0].data)
    .find((d: { action: string }) => d.action === action);
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
      parentsUpdated: 0,
      supersededPriorAiCount: 0,
      transactionsInserted: 0,
      cellsSkippedManuallyOwned: 0,
      orphanedTotals: 0,
      orphanedTransactions: 0,
    });
    expect(m.update).not.toHaveBeenCalled();
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

describe("applyContributionTransactions — happy path (all labels match)", () => {
  it("updates parents by label, inserts transactions, writes one batch audit", async () => {
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

    expect(m.update).toHaveBeenCalledTimes(2);
    // Parents updated by id resolved via label match. taxYearLabel is NEVER
    // written to the update payload — CA relabel authority preserved by
    // the absence, not by an explicit undefined.
    const firstUpdate = m.update.mock.calls[0][0];
    expect(firstUpdate.where).toEqual({ id: "parent-1" });
    expect(firstUpdate.data.taxYearLabel).toBeUndefined();
    expect(firstUpdate.data.employerAiTotal).toBeInstanceOf(Prisma.Decimal);
    expect(firstUpdate.data.personalAiTotal).toBeInstanceOf(Prisma.Decimal);

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
      parentsUpdated: 2,
      supersededPriorAiCount: 0,
      transactionsInserted: 4,
      cellsSkippedManuallyOwned: 0,
      orphanedTotals: 0,
      orphanedTransactions: 0,
    });

    // One audit row for the batch — no orphan audits because nothing was orphaned.
    expect(m.auditCreate).toHaveBeenCalledOnce();
    const audit = m.auditCreate.mock.calls[0][0].data;
    expect(audit.action).toBe("CONTRIBUTION_TRANSACTION_ADDED");
    expect(audit.source).toBe("AI");
    expect(audit.metadata.transactionsInserted).toBe(4);
    expect(audit.metadata.parentsUpdated).toBe(2);
    expect(audit.metadata.orphanedTotals).toBe(0);
    expect(audit.metadata.orphanedTransactions).toBe(0);
    expect(audit.metadata.skippedCells).toEqual([]);
  });
});

describe("applyContributionTransactions — parent update semantics", () => {
  it("update payload OMITS taxYearLabel so a CA relabel is not overwritten", async () => {
    // CA relabelled parent 1 to a free-text form. Pipeline sends its own
    // "2025/26" label — that label won't match parent 1's stored label,
    // so parent 1 receives NO update (it's orphaned). Test the flip side
    // in the next case; here just pin the never-write-taxYearLabel rule.
    const m = makeMockTx({
      parentsInDb: [{ id: "parent-1", position: 1, taxYearLabel: "2025/26" }],
    });
    await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [total({ position: 1, taxYearLabel: "2025/26", employerAiTotal: 5000, personalAiTotal: 1000 })],
      tx: m.tx,
    });
    const updateArg = m.update.mock.calls[0][0];
    expect(updateArg.data.taxYearLabel).toBeUndefined();
    expect(updateArg.data.employerAiTotal).toBeInstanceOf(Prisma.Decimal);
    expect(updateArg.data.personalAiTotal).toBeInstanceOf(Prisma.Decimal);
  });

  it("orphans a total whose pipeline label does not match any parent's label", async () => {
    // The parent's label was CA-relabelled to a free-text form. Pipeline's
    // canonical "2025/26" no longer matches. The parent is untouched (no
    // silent overwrite by position — that was the corruption path). The
    // total is orphaned and shows up in the audit metadata for the reviewer.
    const m = makeMockTx({
      parentsInDb: [{ id: "parent-1", position: 1, taxYearLabel: "6 April 2025 – 5 April 2026" }],
    });
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [total({ position: 1, taxYearLabel: "2025/26", employerAiTotal: 5000, personalAiTotal: 1000 })],
      tx: m.tx,
    });
    expect(m.update).not.toHaveBeenCalled();
    expect(result.parentsUpdated).toBe(0);
    expect(result.orphanedTotals).toBe(1);

    const totalAudit = findAuditByAction(m.auditCreate, "CONTRIBUTION_TOTAL_ORPHANED");
    expect(totalAudit).toBeDefined();
    expect(totalAudit.metadata.orphanedTotals).toEqual([
      { label: "2025/26", employerAiTotal: 5000, personalAiTotal: 1000 },
    ]);
    expect(totalAudit.metadata.parentLabelsInDb).toEqual(["6 April 2025 – 5 April 2026"]);
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
  it("skips AI insertion into a cell with a non-superseded MANUAL row", async () => {
    // Parent AiTotal WAS updated even for a manually-owned cell — this is
    // deliberate: schema.prisma keeps AiTotal as forensic record even when
    // the visible cell renders the CA's manual value. The tx child rows
    // are what's skipped.
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

    // Parent AiTotal was still written — forensics preserved.
    expect(m.update).toHaveBeenCalledOnce();
    expect(m.update.mock.calls[0][0].data.employerAiTotal).toBeInstanceOf(Prisma.Decimal);

    // Only the PERSONAL row survives insertion — both EMPLOYER rows skipped.
    expect(m.createMany).toHaveBeenCalledOnce();
    const rows = m.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("PERSONAL");

    expect(result.transactionsInserted).toBe(1);
    expect(result.cellsSkippedManuallyOwned).toBe(1);
    expect(result.orphanedTransactions).toBe(0);

    // Audit records WHICH cell was held back, not just the count.
    const addedAudit = findAuditByAction(m.auditCreate, "CONTRIBUTION_TRANSACTION_ADDED");
    expect(addedAudit.metadata.skippedCells).toEqual([
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

describe("applyContributionTransactions — orphan transaction (no matching parent)", () => {
  it("routes an unmatched-label transaction to an orphan audit, does not throw", async () => {
    // The document carried a tax year the case's parent set doesn't have.
    // Under the pre-2026-09-16 rules this would have position-fallen-back
    // into a plausible-but-wrong parent. Now it produces an orphan audit
    // with the label + type + count + totalAmount.
    const m = makeMockTx({
      parentsInDb: [{ id: "parent-1", position: 1, taxYearLabel: "2025/26" }],
    });
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [], // pipeline sent no totals AND DB has no parent for 1999/2000
      transactions: [
        txRow({ taxYearLabel: "1999/2000", type: "EMPLOYER", amount: 50 }),
        txRow({ taxYearLabel: "1999/2000", type: "EMPLOYER", amount: 75 }),
        txRow({ taxYearLabel: "1999/2000", type: "PERSONAL", amount: 25 }),
      ],
      tx: m.tx,
    });
    expect(result.orphanedTransactions).toBe(3);
    expect(result.transactionsInserted).toBe(0);
    expect(m.createMany).not.toHaveBeenCalled();

    // Batch audit still fires — its metadata carries the orphan count.
    const addedAudit = findAuditByAction(m.auditCreate, "CONTRIBUTION_TRANSACTION_ADDED");
    expect(addedAudit.metadata.orphanedTransactions).toBe(3);

    // Orphan-specific audit carries the aggregated breakdown. totalAmount
    // is a Prisma.Decimal so audit metadata does not carry float drift
    // ("135.65000000000001" was the old shape); toString() is the
    // human-readable form Prisma writes into a JSON column.
    const txAudit = findAuditByAction(m.auditCreate, "CONTRIBUTION_TX_ORPHANED");
    expect(txAudit).toBeDefined();
    const byLabel = txAudit.metadata.orphanedByLabel;
    expect(byLabel).toHaveLength(2);
    expect(byLabel[0]).toMatchObject({
      label: "1999/2000",
      type: "EMPLOYER",
      count: 2,
    });
    expect(byLabel[0].totalAmount).toBeInstanceOf(Prisma.Decimal);
    expect(byLabel[0].totalAmount.toString()).toBe("125");
    expect(byLabel[1]).toMatchObject({
      label: "1999/2000",
      type: "PERSONAL",
      count: 1,
    });
    expect(byLabel[1].totalAmount.toString()).toBe("25");
    expect(txAudit.metadata.parentLabelsInDb).toEqual(["2025/26"]);
  });

  it("orphan totalAmount uses Decimal (not float) so audit metadata avoids drift", async () => {
    // The precise regression: three £43.73/£36.43/£55.49 rows would sum to
    // 135.65000000000001 under `number` addition (the exact FH-2026-000121
    // shape). Prisma.Decimal makes it 135.65 clean.
    const m = makeMockTx({
      parentsInDb: [{ id: "parent-1", position: 1, taxYearLabel: "2025/26" }],
    });
    await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      transactions: [
        txRow({ taxYearLabel: "2024/25", type: "PERSONAL", amount: 43.73 }),
        txRow({ taxYearLabel: "2024/25", type: "PERSONAL", amount: 36.43 }),
        txRow({ taxYearLabel: "2024/25", type: "PERSONAL", amount: 55.49 }),
      ],
      tx: m.tx,
    });
    const txAudit = findAuditByAction(m.auditCreate, "CONTRIBUTION_TX_ORPHANED");
    expect(txAudit).toBeDefined();
    const bucket = txAudit.metadata.orphanedByLabel[0];
    expect(bucket.totalAmount).toBeInstanceOf(Prisma.Decimal);
    // NOT 135.65000000000001.
    expect(bucket.totalAmount.toString()).toBe("135.65");
  });
});

describe("applyContributionTransactions — label normalisation", () => {
  // Deliberately conservative: normalise whitespace and the 4-digit end
  // year, nothing else. Fuzzy year matching would be its own hazard
  // (off-by-one silent misattribution — the exact class the rewrite
  // closed), so hyphen separators and free-text date ranges are left as
  // orphans.
  it("matches when the parent stores 2025/2026 and the pipeline sends 2025/26", async () => {
    const m = makeMockTx({
      parentsInDb: [{ id: "parent-1", position: 1, taxYearLabel: "2025/2026" }],
    });
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [total({ position: 1, taxYearLabel: "2025/26" })],
      transactions: [txRow({ taxYearLabel: "2025/26" })],
      tx: m.tx,
    });
    expect(result.parentsUpdated).toBe(1);
    expect(result.orphanedTotals).toBe(0);
    expect(result.transactionsInserted).toBe(1);
    expect(result.orphanedTransactions).toBe(0);
    // Update target resolved to the correct parent id via normalised match.
    expect(m.update.mock.calls[0][0].where).toEqual({ id: "parent-1" });
  });

  it("matches when the parent stores 2025/26 and the pipeline sends 2025/2026", async () => {
    const m = makeMockTx({
      parentsInDb: [{ id: "parent-1", position: 1, taxYearLabel: "2025/26" }],
    });
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [total({ position: 1, taxYearLabel: "2025/2026" })],
      transactions: [txRow({ taxYearLabel: "2025/2026" })],
      tx: m.tx,
    });
    expect(result.parentsUpdated).toBe(1);
    expect(result.transactionsInserted).toBe(1);
    expect(result.orphanedTotals).toBe(0);
    expect(result.orphanedTransactions).toBe(0);
  });

  it("collapses internal + surrounding whitespace before comparing", async () => {
    const m = makeMockTx({
      parentsInDb: [{ id: "parent-1", position: 1, taxYearLabel: " 2025 / 26 " }],
    });
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [total({ position: 1, taxYearLabel: "2025/26" })],
      transactions: [txRow({ taxYearLabel: "2025/26" })],
      tx: m.tx,
    });
    expect(result.parentsUpdated).toBe(1);
    expect(result.transactionsInserted).toBe(1);
  });

  it("does NOT collapse an arithmetically invalid 4-digit pair (2025/2030)", async () => {
    // Guard against a fuzz that would over-match. "2025/2030" is nonsense
    // as a tax-year label; do not silently normalise it into "2025/26".
    const m = makeMockTx({
      parentsInDb: [{ id: "parent-1", position: 1, taxYearLabel: "2025/26" }],
    });
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [total({ position: 1, taxYearLabel: "2025/2030" })],
      tx: m.tx,
    });
    expect(result.parentsUpdated).toBe(0);
    expect(result.orphanedTotals).toBe(1);
  });

  it("does NOT normalise hyphen or free-text formats — they orphan (deliberate)", async () => {
    // Hyphen and free-text ranges are common CA relabels. We prefer an
    // orphan (visible in the audit timeline) to a fuzz-match that could
    // land data one year off silently.
    const m = makeMockTx({
      parentsInDb: [
        { id: "parent-hyphen", position: 1, taxYearLabel: "2025-26" },
        { id: "parent-freetext", position: 2, taxYearLabel: "6 April 2024 – 5 April 2025" },
      ],
    });
    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      totals: [
        total({ position: 1, taxYearLabel: "2025/26" }),
        total({ position: 2, taxYearLabel: "2024/25" }),
      ],
      tx: m.tx,
    });
    expect(result.parentsUpdated).toBe(0);
    expect(result.orphanedTotals).toBe(2);
    expect(m.update).not.toHaveBeenCalled();
  });
});

describe("applyContributionTransactions — synthetic year-mismatch regression", () => {
  // This is the shape that would have corrupted data under the pre-2026-09-16
  // rules — Postgres has the current rolling 4-year window auto-seeded
  // (2026/27, 2025/26, 2024/25, 2023/24), while the document Cosmos returns
  // covers older years (2024/25, 2023/24, 2022/23). Under position-based
  // matching:
  //   - Cosmos position 1 (2024/25 totals) would have overwritten Postgres
  //     position 1's AI totals under label "2026/27" — WRONG.
  //   - Cosmos position 3 (2022/23) would have overwritten Postgres position
  //     3 (label "2024/25") — WRONG, and 2022/23 transactions would have
  //     position-fallback-landed there too.
  // Under label-truth:
  //   - 2024/25 total → Postgres parent labelled 2024/25 (position 3). ✓
  //   - 2023/24 total → Postgres parent labelled 2023/24 (position 4). ✓
  //   - 2022/23 total → NO parent → orphaned. ✓
  //   - 2024/25 transactions → Postgres parent labelled 2024/25 (position 3). ✓
  //   - 2023/24 transactions → Postgres parent labelled 2023/24 (position 4). ✓
  //   - 2022/23 transactions → NO parent → orphaned. ✓
  it("routes matching-label rows correctly and orphans out-of-window rows", async () => {
    const parents = [
      { id: "parent-p1", position: 1, taxYearLabel: "2026/27" },
      { id: "parent-p2", position: 2, taxYearLabel: "2025/26" },
      { id: "parent-p3", position: 3, taxYearLabel: "2024/25" },
      { id: "parent-p4", position: 4, taxYearLabel: "2023/24" },
    ];
    const m = makeMockTx({ parentsInDb: parents });

    const result = await applyContributionTransactions({
      caseId: CASE_ID,
      documentId: DOC_ID,
      jobId: JOB_ID,
      // Cosmos-style totals: positions are 1..3 relative to the document,
      // NOT to the case. Labels are what the document actually contains.
      totals: [
        total({ position: 1, taxYearLabel: "2024/25", employerAiTotal: 1202.94, personalAiTotal: 1077.57 }),
        total({ position: 2, taxYearLabel: "2023/24", employerAiTotal: 1467.36, personalAiTotal: 1177.36 }),
        total({ position: 3, taxYearLabel: "2022/23", employerAiTotal: 330.8, personalAiTotal: 276.03 }),
      ],
      transactions: [
        txRow({ type: "PERSONAL", taxYearLabel: "2024/25", amount: 43.73 }),
        txRow({ type: "PERSONAL", taxYearLabel: "2024/25", amount: 36.43 }),
        txRow({ type: "EMPLOYER", taxYearLabel: "2023/24", amount: 100 }),
        txRow({ type: "PERSONAL", taxYearLabel: "2022/23", amount: 20 }),
        txRow({ type: "PERSONAL", taxYearLabel: "2022/23", amount: 30 }),
      ],
      tx: m.tx,
    });

    // Two totals matched, one orphaned. Under the OLD rules, three parents
    // (positions 1-3) would have been overwritten — that would be a
    // three-parent misattribution. This assertion locks the change.
    expect(result.parentsUpdated).toBe(2);
    expect(result.orphanedTotals).toBe(1);
    expect(m.update).toHaveBeenCalledTimes(2);

    // Confirm the RIGHT parents got updated — position 3 (2024/25) and
    // position 4 (2023/24). If a future edit revives position-based
    // routing, this assertion catches the regression on the exact case
    // shape the ADR calls out.
    const updatedIds = m.update.mock.calls.map((c) => c[0].where.id).sort();
    expect(updatedIds).toEqual(["parent-p3", "parent-p4"]);
    // Position 1 (2026/27) and position 2 (2025/26) MUST NOT be touched.
    expect(updatedIds).not.toContain("parent-p1");
    expect(updatedIds).not.toContain("parent-p2");

    // Position 3 update carries the 2024/25 total, not the 2022/23 total
    // it would have received under position-based routing.
    const p3Update = m.update.mock.calls.find((c) => c[0].where.id === "parent-p3")![0];
    // Prisma.Decimal equality via toString — matches how the DB stores it.
    expect((p3Update.data.employerAiTotal as Prisma.Decimal).toString()).toBe("1202.94");
    expect((p3Update.data.personalAiTotal as Prisma.Decimal).toString()).toBe("1077.57");
    // Position 4 update carries the 2023/24 total.
    const p4Update = m.update.mock.calls.find((c) => c[0].where.id === "parent-p4")![0];
    expect((p4Update.data.employerAiTotal as Prisma.Decimal).toString()).toBe("1467.36");
    expect((p4Update.data.personalAiTotal as Prisma.Decimal).toString()).toBe("1177.36");

    // Three transactions matched, two orphaned. Under old rules the
    // orphaned ones would have landed under parent-p3 by position-fallback
    // — 2022/23 money attributed to 2024/25.
    expect(result.transactionsInserted).toBe(3);
    expect(result.orphanedTransactions).toBe(2);

    const insertedRows = m.createMany.mock.calls[0][0].data;
    const parentIdsInserted = insertedRows.map((r: { contributionId: string }) => r.contributionId).sort();
    // Only p3 (2024/25) and p4 (2023/24) receive children — never p1/p2/orphan.
    expect(new Set(parentIdsInserted)).toEqual(new Set(["parent-p3", "parent-p3", "parent-p4"]));

    // Two orphan audits — one for the total, one for the transactions.
    const totalAudit = findAuditByAction(m.auditCreate, "CONTRIBUTION_TOTAL_ORPHANED");
    expect(totalAudit).toBeDefined();
    expect(totalAudit.metadata.orphanedTotals).toEqual([
      { label: "2022/23", employerAiTotal: 330.8, personalAiTotal: 276.03 },
    ]);
    expect(totalAudit.metadata.parentLabelsInDb).toEqual([
      "2026/27",
      "2025/26",
      "2024/25",
      "2023/24",
    ]);

    const txAudit = findAuditByAction(m.auditCreate, "CONTRIBUTION_TX_ORPHANED");
    expect(txAudit).toBeDefined();
    const byLabel = txAudit.metadata.orphanedByLabel;
    expect(byLabel).toHaveLength(1);
    expect(byLabel[0]).toMatchObject({ label: "2022/23", type: "PERSONAL", count: 2 });
    expect(byLabel[0].totalAmount).toBeInstanceOf(Prisma.Decimal);
    expect(byLabel[0].totalAmount.toString()).toBe("50");
    expect(txAudit.metadata.parentLabelsInDb).toEqual([
      "2026/27",
      "2025/26",
      "2024/25",
      "2023/24",
    ]);
  });
});
