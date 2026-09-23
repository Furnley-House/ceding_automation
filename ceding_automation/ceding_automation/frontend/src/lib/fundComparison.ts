// frontend/src/lib/fundComparison.ts
//
// Compares what the CA entered on the checklist against what verification
// found in the fund master / FE Fund Info, one holding at a time.
//
// Pure on purpose: what counts as a disagreement is a judgement about the
// data, not about the screen, and it is the judgement the CA acts on at
// stage 6. It belongs somewhere it can be argued with and tested.

import type { FundLine, SourceChoice } from "@/hooks/useFundLines";

export type ValueSource = "CEDING" | "LOOKUP";

export type ComparisonStatus =
  /** Both sides have a figure and they agree (within tolerance). */
  | "match"
  /** Both sides have a figure and they do not agree — the CA must pick one. */
  | "differs"
  /** Only the reference data has it; nothing to decide, LOOKUP is used. */
  | "lookup-only"
  /** Only the CA has it; the reference could not supply one. */
  | "ceding-only"
  /** Neither side has it. */
  | "neither";

export type ComparisonField = "fundName" | "price" | "ocf" | "txCost";

export interface FieldComparison {
  field: ComparisonField;
  label: string;
  status: ComparisonStatus;
  /** What the CA put on the checklist, formatted for display. */
  cedingDisplay: string;
  /** What the reference data returned, formatted for display. */
  lookupDisplay: string;
  /** Which figure is currently set to be pushed to CRM. */
  chosen: ValueSource;
  /** True when the CA has a real decision to make here. */
  needsChoice: boolean;
  /** Present only when a choice is meaningless — explains why it is locked. */
  lockedReason?: string;
}

// -- Tolerances -----------------------------------------------------------
//
// PRICE: the two sides are rarely priced on the same day — the CA reads the
// provider's statement, FE gives its own valuation date — so an exact match
// is not the bar. What matters is whether the difference would move the
// holding's value materially, so this is relative, with a small absolute
// floor for penny prices where a percentage of nearly nothing is noise.
const PRICE_RELATIVE_TOLERANCE = 0.005; // 0.5%
const PRICE_ABSOLUTE_FLOOR = 0.0001;

// CHARGES: an OCF is an attribute of the share class, not of a date, so it
// should not drift at all. This tolerance exists only to absorb rounding
// (0.75 against 0.7500) — one basis point, expressed in the percent scale
// both sides store. Anything wider is a real difference and worth seeing.
const CHARGE_TOLERANCE = 0.01; // percentage points

export function toNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Fold away spelling noise so "RLS Deposit Pn." and "RLS deposit pn" agree. */
export function normaliseName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

export function pricesAgree(a: number, b: number): boolean {
  const tolerance = Math.max(PRICE_ABSOLUTE_FLOOR, Math.abs(b) * PRICE_RELATIVE_TOLERANCE);
  return Math.abs(a - b) <= tolerance;
}

export function chargesAgree(a: number, b: number): boolean {
  return Math.abs(a - b) <= CHARGE_TOLERANCE;
}

// -- Formatting -----------------------------------------------------------
export function fmtPrice(v: number | null): string {
  if (v === null) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(v);
}

export function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(2)}%`;
}

function statusFor(ceding: unknown, lookup: unknown, agree: () => boolean): ComparisonStatus {
  const hasCeding = ceding !== null && ceding !== undefined && ceding !== "";
  const hasLookup = lookup !== null && lookup !== undefined && lookup !== "";
  if (hasCeding && hasLookup) return agree() ? "match" : "differs";
  if (hasLookup) return "lookup-only";
  if (hasCeding) return "ceding-only";
  return "neither";
}

/**
 * Which figure is actually in force for a field.
 *
 * The stored source is what verification decided, or what the CA overrode it
 * to. Where only one side has a figure the stored value is followed anyway —
 * the server sets it to the side that exists — but the UI locks the control
 * so the CA is not offered a choice between a number and nothing.
 */
function resolveChoice(
  stored: ValueSource | null | undefined,
  status: ComparisonStatus,
): { chosen: ValueSource; needsChoice: boolean; lockedReason?: string } {
  switch (status) {
    case "differs":
      return { chosen: stored ?? "LOOKUP", needsChoice: true };
    case "match":
      return { chosen: stored ?? "LOOKUP", needsChoice: false };
    case "lookup-only":
      return {
        chosen: "LOOKUP",
        needsChoice: false,
        lockedReason: "Nothing on the checklist to compare against",
      };
    case "ceding-only":
      return {
        chosen: "CEDING",
        needsChoice: false,
        lockedReason: "The reference data has no figure for this",
      };
    default:
      return { chosen: "CEDING", needsChoice: false, lockedReason: "No figure on either side" };
  }
}

export interface RowComparison {
  fields: FieldComparison[];
  /** True when at least one field has two figures that disagree. */
  hasDisagreement: boolean;
  /** Verification has run against this row. */
  verified: boolean;
}

export function compareFundLine(row: FundLine): RowComparison {
  const cedingPrice = toNumber(row.pricePerUnit);
  const lookupPrice = toNumber(row.resolvedUnitPrice);
  const cedingOcf = toNumber(row.ocf);
  const lookupOcf = toNumber(row.resolvedOcf);
  const cedingTx = toNumber(row.transactionCosts);
  const lookupTx = toNumber(row.resolvedTxCost);

  const nameStatus = statusFor(
    row.fundName,
    row.resolvedFundName,
    () => normaliseName(row.fundName) === normaliseName(row.resolvedFundName),
  );
  const priceStatus = statusFor(cedingPrice, lookupPrice, () =>
    pricesAgree(cedingPrice as number, lookupPrice as number),
  );
  const ocfStatus = statusFor(cedingOcf, lookupOcf, () =>
    chargesAgree(cedingOcf as number, lookupOcf as number),
  );
  const txStatus = statusFor(cedingTx, lookupTx, () =>
    chargesAgree(cedingTx as number, lookupTx as number),
  );

  const fields: FieldComparison[] = [
    {
      field: "fundName",
      label: "Fund name",
      status: nameStatus,
      cedingDisplay: row.fundName || "—",
      lookupDisplay: row.resolvedFundName || "—",
      ...resolveChoice(row.fundNameSource, nameStatus),
    },
    {
      field: "price",
      label: "Unit price",
      status: priceStatus,
      cedingDisplay: fmtPrice(cedingPrice),
      lookupDisplay: fmtPrice(lookupPrice),
      ...resolveChoice(row.priceSource, priceStatus),
    },
    {
      field: "ocf",
      label: "OCF",
      status: ocfStatus,
      cedingDisplay: fmtPct(cedingOcf),
      lookupDisplay: fmtPct(lookupOcf),
      ...resolveChoice(row.ocfSource, ocfStatus),
    },
    {
      field: "txCost",
      label: "Transaction costs",
      status: txStatus,
      cedingDisplay: fmtPct(cedingTx),
      lookupDisplay: fmtPct(lookupTx),
      ...resolveChoice(row.txCostSource, txStatus),
    },
  ];

  return {
    fields,
    hasDisagreement: fields.some((f) => f.status === "differs"),
    verified: Boolean(row.verifiedAt),
  };
}

/**
 * Maps a comparison field onto the PATCH body key the API expects. Typed
 * against SourceChoice so a wrong key is a compile error here rather than a
 * 400 the CA sees after clicking.
 */
export const SOURCE_FIELD_KEY: Record<ComparisonField, keyof SourceChoice> = {
  fundName: "fundNameSource",
  price: "priceSource",
  ocf: "ocfSource",
  txCost: "txCostSource",
};

export interface VerificationGate {
  /** Rows exist and every one of them has been verified. */
  satisfied: boolean;
  /** Rows carrying no verification yet. */
  unverified: number;
  total: number;
  disagreements: number;
}

/**
 * Whether stage 6 may be handed on.
 *
 * A case with no holdings has nothing to verify and is never blocked by this
 * — the gate exists to stop unchecked fund figures reaching CRM, and there
 * are none.
 */
export function evaluateGate(rows: FundLine[]): VerificationGate {
  const unverified = rows.filter((r) => !r.verifiedAt).length;
  const disagreements = rows.filter((r) => compareFundLine(r).hasDisagreement).length;
  return {
    satisfied: rows.length === 0 || unverified === 0,
    unverified,
    total: rows.length,
    disagreements,
  };
}
