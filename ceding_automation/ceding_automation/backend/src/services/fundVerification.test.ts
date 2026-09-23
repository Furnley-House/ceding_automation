import { describe, it, expect, beforeEach, vi } from "vitest";
import { HoldingRag, FundValueSource } from "@prisma/client";

const { findManyMock, updateMock, txMock, auditMock, lookupMock, pricesMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  updateMock: vi.fn(),
  txMock: vi.fn(),
  auditMock: vi.fn(),
  lookupMock: vi.fn(),
  pricesMock: vi.fn(),
}));

vi.mock("@prisma/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PrismaClient: vi.fn(() => ({
    checklistFundLine: { findMany: findManyMock, update: updateMock },
    auditLog: { create: auditMock },
    $transaction: txMock,
  })),
}));
vi.mock("./fundMaster", () => ({
  lookupFunds: lookupMock,
  isFundMasterConfigured: () => true,
}));
vi.mock("./feFundInfo", () => ({
  fetchPrices: pricesMock,
  isFeFundInfoConfigured: () => true,
}));

import { deriveVerification, verifyCaseFundLines } from "./fundVerification";

// Shapes taken from live responses (Sept 2026).
const fund = (over: Record<string, unknown> = {}) => ({
  isin: "GB00B4W9CK61",
  citiCode: "ERP7",
  fundName: "Aviva Pen My Future Focus Growth Pn",
  ocf: null as number | null,
  transactionCosts: null as number | null,
  ...over,
});
const price = (over: Record<string, unknown> = {}) => ({
  isin: "GB00B4W9CK61",
  unitPrice: 4.2237,
  priceDate: "2026-09-22",
  citiCode: "ERP7",
  currency: "GBP",
  ...over,
});

describe("deriveVerification", () => {
  it("is AMBER when both a name and a price came back", () => {
    const v = deriveVerification(fund() as never, price() as never);
    expect(v.holdingRag).toBe(HoldingRag.AMBER);
    expect(v.resolvedIsin).toBe("GB00B4W9CK61");
    expect(v.resolvedUnitPrice).toBe(4.2237);
    expect(v.fundNameSource).toBe(FundValueSource.LOOKUP);
    expect(v.priceSource).toBe(FundValueSource.LOOKUP);
  });

  it("is RED when the fund is named but cannot be priced", () => {
    const v = deriveVerification(fund() as never, null);
    expect(v.holdingRag).toBe(HoldingRag.RED);
    expect(v.fundNameSource).toBe(FundValueSource.LOOKUP); // the name is still usable
    expect(v.priceSource).toBe(FundValueSource.CEDING);
  });

  it("is RED when the identifier resolved to nothing at all", () => {
    const v = deriveVerification(null, null);
    expect(v.holdingRag).toBe(HoldingRag.RED);
    expect(v.resolvedIsin).toBeNull();
    expect(v.fundNameSource).toBe(FundValueSource.CEDING);
    expect(v.priceSource).toBe(FundValueSource.CEDING);
  });

  it("refuses a non-GBP price rather than pushing it into a sterling field", () => {
    const v = deriveVerification(fund() as never, price({ currency: "USD", unitPrice: 12.5 }) as never);
    expect(v.resolvedUnitPrice).toBeNull();
    expect(v.holdingRag).toBe(HoldingRag.RED);
    expect(v.priceSource).toBe(FundValueSource.CEDING); // CA keeps their own figure
  });

  it("accepts a price with no stated currency", () => {
    const v = deriveVerification(fund() as never, price({ currency: null }) as never);
    expect(v.resolvedUnitPrice).toBe(4.2237);
    expect(v.holdingRag).toBe(HoldingRag.AMBER);
  });

  // Charges are absent for insured pension share classes: the fund master
  // holds none for them, and FE's Pricing endpoint carries no charge fields.
  it("falls back to the CA figures when the fund master has no charges", () => {
    const v = deriveVerification(fund() as never, price() as never);
    expect(v.resolvedOcf).toBeNull();
    expect(v.ocfSource).toBe(FundValueSource.CEDING);
    expect(v.txCostSource).toBe(FundValueSource.CEDING);
    expect(v.holdingRag).toBe(HoldingRag.AMBER); // charges do not affect RAG
  });

  it("uses the fund master charges when it has them", () => {
    const v = deriveVerification(
      fund({ ocf: 0.75, transactionCosts: 0.09 }) as never,
      price() as never,
    );
    expect(v.resolvedOcf).toBe(0.75);
    expect(v.ocfSource).toBe(FundValueSource.LOOKUP);
    expect(v.txCostSource).toBe(FundValueSource.LOOKUP);
  });
});

describe("verifyCaseFundLines", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    updateMock.mockReset();
    txMock.mockReset().mockResolvedValue([]);
    auditMock.mockReset();
    lookupMock.mockReset();
    pricesMock.mockReset();
    updateMock.mockImplementation((args: unknown) => args);
  });

  const index = (rows: Array<ReturnType<typeof fund>> = []) => ({
    byIsin: new Map(rows.map((r) => [r.isin, r])),
    bySedol: new Map(rows.map((r) => [r.isin.slice(4, 11), r])),
    byCiti: new Map(rows.map((r) => [r.citiCode, r])),
  });

  it("does nothing for a case with no fund lines", async () => {
    findManyMock.mockResolvedValueOnce([]);
    const s = await verifyCaseFundLines("case-1", "user-1");
    expect(s.total).toBe(0);
    expect(lookupMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("looks up once for the whole case, not once per holding", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: "l1", isinSedolCiti: "GB00B4W9CK61" },
      { id: "l2", isinSedolCiti: "B4W9CK6" },
      { id: "l3", isinSedolCiti: "0783248" },
    ]);
    lookupMock.mockResolvedValueOnce(index([fund()]));
    pricesMock.mockResolvedValueOnce(new Map([["GB00B4W9CK61", price()]]));

    await verifyCaseFundLines("case-1", "user-1");
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(pricesMock).toHaveBeenCalledTimes(1);
  });

  it("counts rows with no usable identifier as skipped, and marks them RED", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: "l1", isinSedolCiti: "GB00B4W9CK61" },
      { id: "l2", isinSedolCiti: "N/A" },
      { id: "l3", isinSedolCiti: null },
    ]);
    lookupMock.mockResolvedValueOnce(index([fund()]));
    pricesMock.mockResolvedValueOnce(new Map([["GB00B4W9CK61", price()]]));

    const s = await verifyCaseFundLines("case-1", "user-1");
    expect(s.total).toBe(3);
    expect(s.checked).toBe(1);
    expect(s.skipped).toBe(2);
    expect(s.amber).toBe(1);
    expect(s.red).toBe(2);
  });

  it("writes every row in one transaction", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: "l1", isinSedolCiti: "GB00B4W9CK61" },
      { id: "l2", isinSedolCiti: "N/A" },
    ]);
    lookupMock.mockResolvedValueOnce(index([fund()]));
    pricesMock.mockResolvedValueOnce(new Map([["GB00B4W9CK61", price()]]));

    await verifyCaseFundLines("case-1", "user-1");
    expect(txMock).toHaveBeenCalledTimes(1);
    expect(txMock.mock.calls[0][0]).toHaveLength(2);
  });

  // An outage must never be recorded as a verified RED holding, or the CA
  // approves figures that nothing ever checked.
  it("writes nothing when the fund master is unreachable", async () => {
    findManyMock.mockResolvedValueOnce([{ id: "l1", isinSedolCiti: "GB00B4W9CK61" }]);
    lookupMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(verifyCaseFundLines("case-1", "user-1")).rejects.toThrow();
    expect(txMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("writes nothing when pricing fails", async () => {
    findManyMock.mockResolvedValueOnce([{ id: "l1", isinSedolCiti: "GB00B4W9CK61" }]);
    lookupMock.mockResolvedValueOnce(index([fund()]));
    pricesMock.mockRejectedValueOnce(new Error("FE 500"));

    await expect(verifyCaseFundLines("case-1", "user-1")).rejects.toThrow();
    expect(txMock).not.toHaveBeenCalled();
  });

  it("records one audit entry per run, not per holding", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: "l1", isinSedolCiti: "GB00B4W9CK61" },
      { id: "l2", isinSedolCiti: "B4W9CK6" },
    ]);
    lookupMock.mockResolvedValueOnce(index([fund()]));
    pricesMock.mockResolvedValueOnce(new Map([["GB00B4W9CK61", price()]]));

    await verifyCaseFundLines("case-1", "user-1");
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][0].data.metadata.amber).toBe(2);
  });
});
