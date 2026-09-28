// Detects the pence/pounds mix-up before it reaches CRM.
//
// Most UK funds quote the investor in pence, so that is what a provider
// statement shows and what a CA copying it types. FE Fund Info always reports
// the major unit, and the Zoho price field is pounds. A holding whose
// checklist price is the pence figure therefore goes to CRM 100x too high,
// and the figure looks entirely reasonable on the statement it came from.
//
// The same comparison runs on screen at stage 6 (frontend/src/lib/
// fundComparison.ts) and the tolerances below are deliberately identical to
// the ones there — if you change one, change both, or a holding will warn in
// the panel and pass here.

import { FundValueSource } from "@prisma/client";

const PRICE_RELATIVE_TOLERANCE = 0.005; // 0.5%
const PRICE_ABSOLUTE_FLOOR = 0.0001;

/** Prices are rarely struck on the same day, so "agree" is relative. */
export function pricesAgree(a: number, b: number): boolean {
  const tolerance = Math.max(PRICE_ABSOLUTE_FLOOR, Math.abs(b) * PRICE_RELATIVE_TOLERANCE);
  return Math.abs(a - b) <= tolerance;
}

/**
 * The factor the CHECKLIST figure would need for the two to agree, or null if
 * the gap is not a clean 100x — in which case it is a real difference in
 * price, not a difference in units, and not this check's business.
 *
 * 0.01 is the pence case: checklist 137.68 against reference 1.3768.
 * 100 is the mirror image, a decimal point one place too far left.
 */
export function scaleFactorBetween(ceding: number, lookup: number): 100 | 0.01 | null {
  if (ceding === 0 || lookup === 0) return null;
  if (pricesAgree(ceding * 100, lookup)) return 100;
  if (pricesAgree(ceding / 100, lookup)) return 0.01;
  return null;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(typeof v === "object" ? String(v) : v);
  return Number.isFinite(n) ? n : null;
}

export interface ScaleCandidate {
  fundName: string;
  priceSource: FundValueSource | null;
  pricePerUnit: unknown;
  resolvedUnitPrice: unknown;
}

export interface PriceScaleIssue {
  fundName: string;
  checklist: number;
  reference: number;
  factor: 100 | 0.01;
}

/**
 * Holdings where the checklist price is the one bound for CRM and it sits a
 * clean 100x away from the reference.
 *
 * Only the checklist side is ever flagged. Where the CA has picked the
 * reference figure the export is already correct, however odd the checklist
 * looks, and warning about it would be noise.
 */
export function detectPriceScaleIssues(
  lines: readonly ScaleCandidate[],
): PriceScaleIssue[] {
  const issues: PriceScaleIssue[] = [];

  for (const line of lines) {
    const ceding = toNumber(line.pricePerUnit);
    const lookup = toNumber(line.resolvedUnitPrice);
    if (ceding === null || lookup === null) continue;

    // Mirrors chosen() in holdingsSubform: LOOKUP wins only when it has a
    // figure to offer, so anything else leaves the checklist price in force.
    const referenceInForce = line.priceSource === FundValueSource.LOOKUP;
    if (referenceInForce) continue;

    const factor = scaleFactorBetween(ceding, lookup);
    if (factor === null) continue;

    issues.push({ fundName: line.fundName, checklist: ceding, reference: lookup, factor });
  }

  return issues;
}

/**
 * One line a CA can act on without opening anything:
 * "Vanguard FTSE Global All Cap — checklist 137.68, reference 1.3768 (100x too high)"
 */
export function describeScaleIssue(issue: PriceScaleIssue): string {
  const direction = issue.factor === 0.01 ? "100x too high" : "100x too low";
  return (
    `${issue.fundName} — checklist ${issue.checklist}, ` +
    `reference ${issue.reference} (${direction})`
  );
}
