import { PrismaClient, HoldingRag, FundValueSource } from "@prisma/client";
import { classifyFundIdentifier, collectLookupKeys } from "../utils/fundIdentifier";
import {
  lookupFunds,
  isFundMasterConfigured,
  type FundMasterIndex,
  type FundMasterRow,
} from "./fundMaster";
import { fetchPrices, isFeFundInfoConfigured, type FundPrice } from "./feFundInfo";

const prisma = new PrismaClient();

const REPORTING_CURRENCY = "GBP";

export interface VerificationSummary {
  caseId: string;
  /** Fund lines on the case. */
  total: number;
  /** Rows carrying an identifier we could act on. */
  checked: number;
  amber: number;
  red: number;
  /** Rows with no usable identifier — RED, and they never block stage 6. */
  skipped: number;
}

export function isVerificationConfigured(): boolean {
  return isFundMasterConfigured() && isFeFundInfoConfigured();
}

/** What verification writes to a single fund line. */
export interface RowVerification {
  resolvedIsin: string | null;
  resolvedFundName: string | null;
  resolvedUnitPrice: number | null;
  resolvedPriceDate: Date | null;
  resolvedOcf: number | null;
  resolvedTxCost: number | null;
  holdingRag: HoldingRag;
  fundNameSource: FundValueSource;
  priceSource: FundValueSource;
  ocfSource: FundValueSource;
  txCostSource: FundValueSource;
  verifiedAt: Date;
}

export function deriveVerification(
  fund: FundMasterRow | null,
  price: FundPrice | null,
  now: Date = new Date(),
): RowVerification {
  const name = fund?.fundName?.trim() || null;

  const usablePrice =
    price && (!price.currency || price.currency.toUpperCase() === REPORTING_CURRENCY)
      ? price
      : null;

  const ocf = fund?.ocf ?? null;
  const txCost = fund?.transactionCosts ?? null;

  const pick = (v: unknown): FundValueSource =>
    v === null || v === undefined ? FundValueSource.CEDING : FundValueSource.LOOKUP;

  return {
    resolvedIsin: fund?.isin ?? null,
    resolvedFundName: name,
    resolvedUnitPrice: usablePrice?.unitPrice ?? null,
    resolvedPriceDate: usablePrice?.priceDate ? new Date(usablePrice.priceDate) : null,
    resolvedOcf: ocf,
    resolvedTxCost: txCost,
    holdingRag: name && usablePrice ? HoldingRag.AMBER : HoldingRag.RED,
    fundNameSource: pick(name),
    priceSource: pick(usablePrice?.unitPrice ?? null),
    ocfSource: pick(ocf),
    txCostSource: pick(txCost),
    verifiedAt: now,
  };
}

function matchFund(index: FundMasterIndex, identifier: string | null): FundMasterRow | null {
  const { kind, value } = classifyFundIdentifier(identifier);
  if (!value) return null;
  if (kind === "ISIN") return index.byIsin.get(value) ?? null;
  if (kind === "SEDOL") return index.bySedol.get(value) ?? null;
  if (kind === "CITI") return index.byCiti.get(value) ?? null;
  return null;
}

export async function verifyCaseFundLines(
  caseId: string,
  userId: string,
): Promise<VerificationSummary> {
  const lines = await prisma.checklistFundLine.findMany({
    where: { caseId },
    select: { id: true, isinSedolCiti: true },
    orderBy: { displayOrder: "asc" },
  });

  const summary: VerificationSummary = {
    caseId,
    total: lines.length,
    checked: 0,
    amber: 0,
    red: 0,
    skipped: 0,
  };
  if (lines.length === 0) return summary;

  if (!isVerificationConfigured()) {
    throw new Error(
      "Fund verification is not configured — set FUND_DB_* and FEFUNDINFO_* in the environment",
    );
  }

  // One fund-master query and one batched price call for the whole case,
  // rather than a round trip per holding.
  const keys = collectLookupKeys(lines.map((l) => l.isinSedolCiti));
  const index = await lookupFunds(keys);

  const matches = new Map<string, FundMasterRow | null>();
  for (const line of lines) matches.set(line.id, matchFund(index, line.isinSedolCiti));

  const isins = [...new Set([...matches.values()].filter(Boolean).map((f) => f!.isin))];
  const prices = await fetchPrices(isins);

  const now = new Date();
  const writes = lines.map((line) => {
    const fund = matches.get(line.id) ?? null;
    const price = fund ? prices.get(fund.isin) ?? null : null;
    const v = deriveVerification(fund, price, now);

    if (classifyFundIdentifier(line.isinSedolCiti).value === null) summary.skipped += 1;
    else summary.checked += 1;
    if (v.holdingRag === HoldingRag.AMBER) summary.amber += 1;
    else summary.red += 1;

    return prisma.checklistFundLine.update({ where: { id: line.id }, data: v });
  });

  await prisma.$transaction(writes);

  // One entry per run rather than per holding — the detail lives on the rows,
  // and a 20-holding case should not bury the rest of the trail.
  await prisma.auditLog.create({
    data: {
      caseId,
      userId,
      action: "FUND_LINE_UPDATED",
      source: "SYSTEM",
      newValue: `Verified ${summary.checked} holding${summary.checked === 1 ? "" : "s"} — ${summary.amber} amber, ${summary.red} red`,
      metadata: {
        reason: "fund-master-verification",
        total: summary.total,
        checked: summary.checked,
        skipped: summary.skipped,
        amber: summary.amber,
        red: summary.red,
      },
    },
  });

  return summary;
}
