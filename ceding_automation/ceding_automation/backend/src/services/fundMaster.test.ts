import { describe, it, expect, beforeEach, vi } from "vitest";

const { queryMock, poolCtor } = vi.hoisted(() => {
  const queryMock = vi.fn();
  return {
    queryMock,
    poolCtor: vi.fn(() => ({ query: queryMock, on: vi.fn(), end: vi.fn() })),
  };
});
vi.mock("pg", () => ({ Pool: poolCtor }));

import {
  lookupFunds,
  isFundMasterConfigured,
  closeFundMasterPool,
  assertReadOnly,
} from "./fundMaster";

const row = (over: Record<string, unknown> = {}) => ({
  isin: "GB00B4W9CK61",
  citi_code: "0SVM",
  fund_name: "Aviva Pen My Future Focus Growth Pn",
  ongoing_charges: "0.007500", // fractions in the table; 0.75% in the world
  tx_costs: "0.000900",
  ...over,
});

beforeEach(async () => {
  await closeFundMasterPool();
  queryMock.mockReset();
  poolCtor.mockClear();
  process.env.FUND_DB_HOST = "fund-host";
  process.env.FUND_DB_NAME = "production";
  process.env.FUND_DB_USER = "reader";
});

describe("isFundMasterConfigured", () => {
  it("is false when the connection details are absent", () => {
    delete process.env.FUND_DB_HOST;
    expect(isFundMasterConfigured()).toBe(false);
  });

  it("is true once host, database and user are set", () => {
    expect(isFundMasterConfigured()).toBe(true);
  });
});

describe("lookupFunds", () => {
  it("does not open a connection when nothing is usable", async () => {
    const index = await lookupFunds({ isins: [], sedols: [], citiCodes: [] });
    expect(queryMock).not.toHaveBeenCalled();
    expect(index.byIsin.size).toBe(0);
  });

  it("sends all three identifier sets in ONE query", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row()] });
    await lookupFunds({
      isins: ["GB00B84QS166"],
      sedols: ["B4W9CK6", "0783248"],
      citiCodes: ["0SVM"],
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("substring(isin from 5 for 7)");
    expect(params).toEqual([
      ["GB00B84QS166"],
      ["B4W9CK6", "0783248"],
      ["0SVM"],
    ]);
  });

  it("passes identifiers as parameters, never interpolated into the SQL", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await lookupFunds({ isins: ["GB00B4W9CK61"], sedols: [], citiCodes: [] });
    const [sql] = queryMock.mock.calls[0];
    expect(sql).not.toContain("GB00B4W9CK61");
  });

  it("indexes a GB row by ISIN, by its embedded SEDOL, and by Citi code", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row()] });
    const index = await lookupFunds({ isins: [], sedols: ["B4W9CK6"], citiCodes: [] });

    // GB00 B4W9CK6 1 — positions 5-11 are the SEDOL
    expect(index.byIsin.get("GB00B4W9CK61")?.fundName).toContain("Aviva");
    expect(index.bySedol.get("B4W9CK6")?.isin).toBe("GB00B4W9CK61");
    expect(index.byCiti.get("0SVM")?.isin).toBe("GB00B4W9CK61");
  });

  it("does not derive a SEDOL for a non-GB ISIN", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ isin: "IE00B4W9CK61" })] });
    const index = await lookupFunds({ isins: ["IE00B4W9CK61"], sedols: [], citiCodes: [] });
    expect(index.byIsin.has("IE00B4W9CK61")).toBe(true);
    expect(index.bySedol.size).toBe(0);
  });

  it("converts numeric strings from pg into numbers", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row()] });
    const index = await lookupFunds({ isins: ["GB00B4W9CK61"], sedols: [], citiCodes: [] });
    const hit = index.byIsin.get("GB00B4W9CK61")!;
    expect(hit.ocf).toBe(0.75);
    expect(hit.transactionCosts).toBe(0.09);
  });

  it("keeps a row whose charges are missing rather than dropping it", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [row({ ongoing_charges: null, tx_costs: null })],
    });
    const index = await lookupFunds({ isins: ["GB00B4W9CK61"], sedols: [], citiCodes: [] });
    const hit = index.byIsin.get("GB00B4W9CK61")!;
    expect(hit.fundName).toContain("Aviva"); // name still usable
    expect(hit.ocf).toBeNull();
    expect(hit.transactionCosts).toBeNull();
  });

  it("reuses one pool across calls", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await lookupFunds({ isins: ["GB00B4W9CK61"], sedols: [], citiCodes: [] });
    await lookupFunds({ isins: ["GB00B84QS166"], sedols: [], citiCodes: [] });
    expect(poolCtor).toHaveBeenCalledTimes(1);
  });

  it("refuses to connect when the fund master is not configured", async () => {
    delete process.env.FUND_DB_HOST;
    await expect(
      lookupFunds({ isins: ["GB00B4W9CK61"], sedols: [], citiCodes: [] }),
    ).rejects.toThrow(/not configured/i);
  });
});

// The credential we hold can write to another team's production table. These
// cover the two guards that stand in for the read-only grant we do not have.
describe("read-only enforcement", () => {
  it("allows a plain SELECT", () => {
    expect(() => assertReadOnly("SELECT isin FROM fund_master_feed")).not.toThrow();
  });

  it("allows a SELECT that opens with a comment", () => {
    expect(() =>
      assertReadOnly("-- one statement for a whole case\nSELECT isin FROM fund_master_feed"),
    ).not.toThrow();
  });

  it.each([
    ["UPDATE fund_master_feed SET isin = 'x'"],
    ["DELETE FROM fund_master_feed"],
    ["INSERT INTO fund_master_feed (isin) VALUES ('x')"],
    ["TRUNCATE fund_master_feed"],
    ["DROP TABLE fund_master_feed"],
    ["CREATE INDEX ix ON fund_master_feed (isin)"],
  ])("refuses %s", (sql) => {
    expect(() => assertReadOnly(sql)).toThrow(/only run SELECT/i);
  });

  it("refuses a second statement hidden behind a SELECT", () => {
    expect(() =>
      assertReadOnly("SELECT 1; DELETE FROM fund_master_feed"),
    ).toThrow(/single statement/i);
  });

  it("refuses a write hidden behind a comment", () => {
    expect(() => assertReadOnly("/* SELECT */ DELETE FROM fund_master_feed")).toThrow(
      /only run SELECT/i,
    );
  });

  it("tolerates a trailing semicolon", () => {
    expect(() => assertReadOnly("SELECT isin FROM fund_master_feed;")).not.toThrow();
  });

  it("puts every new connection into a read-only session", async () => {
    const handlers: Record<string, (c: unknown) => void> = {};
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    poolCtor.mockImplementationOnce(() => ({
      query: queryMock,
      on: vi.fn((evt: string, fn: (c: unknown) => void) => {
        handlers[evt] = fn;
      }),
      end: vi.fn(),
    }));
    queryMock.mockResolvedValue({ rows: [] });

    await lookupFunds({ isins: ["GB00B4W9CK61"], sedols: [], citiCodes: [] });

    expect(handlers.connect).toBeTypeOf("function");
    handlers.connect({ query: clientQuery });
    expect(clientQuery).toHaveBeenCalledWith(
      "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
    );
  });
});

// The fund master stores charges as decimal fractions; ceding and the Zoho
// subform use percent. A missed conversion is a 100x error in a figure that
// reaches CRM, so the scale is pinned here rather than trusted to a comment.
describe("charge scale", () => {
  it("converts a fraction to a percentage", async () => {
    // Vanguard LifeStrategy publishes 0.22%; the table holds 0.002000.
    queryMock.mockResolvedValueOnce({
      rows: [row({ isin: "GB00B3ZHN960", ongoing_charges: "0.002000" })],
    });
    const index = await lookupFunds({ isins: ["GB00B3ZHN960"], sedols: [], citiCodes: [] });
    expect(index.byIsin.get("GB00B3ZHN960")!.ocf).toBe(0.2);
  });

  it("does not leave binary floating-point dust in a charge", async () => {
    // 0.0077 * 100 is 0.7699999999999999 unrounded.
    queryMock.mockResolvedValueOnce({ rows: [row({ ongoing_charges: "0.007700" })] });
    const index = await lookupFunds({ isins: ["GB00B4W9CK61"], sedols: [], citiCodes: [] });
    expect(index.byIsin.get("GB00B4W9CK61")!.ocf).toBe(0.77);
  });

  // Negative ex-ante transaction costs are real — the EMT methodology nets
  // slippage, and 1,344 rows in the table are below zero.
  it("keeps a negative transaction cost", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ tx_costs: "-0.001841" })] });
    const index = await lookupFunds({ isins: ["GB00B4W9CK61"], sedols: [], citiCodes: [] });
    expect(index.byIsin.get("GB00B4W9CK61")!.transactionCosts).toBe(-0.1841);
  });

  it("leaves a zero charge as zero rather than dropping it", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ ongoing_charges: "0.000000" })] });
    const index = await lookupFunds({ isins: ["GB00B4W9CK61"], sedols: [], citiCodes: [] });
    expect(index.byIsin.get("GB00B4W9CK61")!.ocf).toBe(0);
  });
});
